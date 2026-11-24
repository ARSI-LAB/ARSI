import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  normalizeFailure,
  type ProgressEvent,
} from 'arsi-evaluator';
import { startCleanupProgress } from '../../src/entries/cli/cleanup-progress.js';
import { startDoctorProgress } from '../../src/entries/cli/doctor-progress.js';
import {
  formatDuration,
  startRunProgress,
} from '../../src/entries/cli/run-progress.js';
import {
  createTerminalRenderer,
  isInteractiveTTY,
  resolveProgressMode,
  sanitizeText,
  supportsColor,
  truncateVisible,
  type ProgressStream,
} from '../../src/entries/cli/terminal-renderer.js';
import {
  summarizeCallOutcome,
  summarizeMeasurement,
  summarizeMeasurementDetails,
} from '../../src/runtime/services/run-progress.js';
import { forwardSdkProgress } from '../../src/plugins/shared/evaluator-adapter/progress.js';
import type {
  CallProgressUpdate,
  RuntimeContext,
} from '../../src/contracts/index.js';
import { agentFixture } from '../fixtures/agent-execution.js';

/** Minimal ANSI screen simulator for the subset used by our sticky renderer. */
function simulateTerminal(chunks: readonly string[]): string[] {
  const lines: string[] = [''];
  let row = 0;
  let col = 0;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; ) {
      const ch = chunk[i]!;
      if (ch === '\x1b' && chunk[i + 1] === '[') {
        const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(chunk.slice(i));
        if (match) {
          const [full, params, cmd] = match;
          if (cmd === 'A') {
            const count = params ? Number(params) : 1;
            row = Math.max(0, row - count);
          } else if (cmd === 'J') {
            lines[row] = lines[row]!.slice(0, col);
            lines.length = row + 1;
          }
          // SGR 'm' codes are stripped for screen-content assertions.
          i += full.length;
          continue;
        }
      }
      if (ch === '\r') {
        col = 0;
        i += 1;
        continue;
      }
      if (ch === '\n') {
        row += 1;
        if (row >= lines.length) lines.push('');
        col = 0;
        i += 1;
        continue;
      }
      const line = lines[row] ?? '';
      lines[row] =
        line.slice(0, col) +
        ch +
        (col + 1 < line.length ? line.slice(col + 1) : '');
      col += 1;
      i += 1;
    }
  }
  return lines;
}

function makeStream(overrides: Partial<Omit<ProgressStream, 'write'>> = {}): {
  stream: ProgressStream;
  chunks: string[];
} {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      isTTY: true,
      columns: 80,
      env: {},
      ...overrides,
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  };
}

test('environment detection obeys TTY, CI, TERM=dumb, and NO_COLOR', () => {
  assert.equal(isInteractiveTTY(makeStream({ isTTY: true }).stream), true);
  assert.equal(isInteractiveTTY(makeStream({ isTTY: false }).stream), false);
  assert.equal(
    isInteractiveTTY(makeStream({ isTTY: true, env: { CI: 'true' } }).stream),
    false,
  );
  assert.equal(
    isInteractiveTTY(makeStream({ isTTY: true, env: { CI: 'false' } }).stream),
    true,
  );
  assert.equal(
    isInteractiveTTY(makeStream({ isTTY: true, env: { TERM: 'dumb' } }).stream),
    false,
  );

  assert.equal(
    resolveProgressMode('auto', makeStream({ isTTY: true }).stream),
    'tty',
  );
  assert.equal(
    resolveProgressMode(
      'auto',
      makeStream({ isTTY: true, env: { CI: '1' } }).stream,
    ),
    'plain',
  );
  assert.equal(
    resolveProgressMode('plain', makeStream({ isTTY: true }).stream),
    'plain',
  );
  assert.equal(
    resolveProgressMode('tty', makeStream({ isTTY: false }).stream),
    'tty',
  );

  assert.equal(supportsColor(makeStream({ isTTY: true }).stream, 'tty'), true);
  assert.equal(
    supportsColor(
      makeStream({ isTTY: true, env: { NO_COLOR: '1' } }).stream,
      'tty',
    ),
    false,
  );
  assert.equal(
    supportsColor(makeStream({ isTTY: true }).stream, 'plain'),
    false,
  );
});

test('truncateVisible preserves ANSI styling and fits within column limits', () => {
  const styled = '\x1b[32mRunning\x1b[0m very-long-task-name-here';
  const truncated = truncateVisible(styled, 16);
  const plain = truncated.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(plain.length, 16);
  assert.ok(plain.endsWith('…'));
  assert.ok(truncated.endsWith('\x1b[0m'));
  assert.equal(sanitizeText('\x1b[31mbad\nline\ttext\x1b[0m'), 'bad line text');
});

test('truncateVisible keeps wide and styled graphemes intact', () => {
  assert.equal(truncateVisible('⌚'.repeat(10), 15), '⌚'.repeat(7) + '…');
  assert.equal(truncateVisible('界'.repeat(10), 15), '界'.repeat(7) + '…');
  assert.equal(truncateVisible('👩‍💻x', 3), '👩‍💻x');
  assert.equal(truncateVisible('a👩‍💻b', 3), 'a…');
  assert.equal(truncateVisible('a1️⃣b', 3), 'a…');
  assert.equal(truncateVisible('e\u0301xx', 2), 'e\u0301…');
  assert.equal(
    truncateVisible('e\x1b[32m\u0301xyz', 2),
    'e\x1b[32m\u0301…\x1b[0m',
  );
});

test('formatDuration scales cleanly across seconds, minutes, and hours', () => {
  assert.equal(formatDuration(420), '0.4s');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(3_661_000), '1h 01m 01s');
});

test('outcome summarizers format measurement metrics and plugin decisions concisely', () => {
  const scalar = (value: number) => ({
    status: 'available',
    value: { kind: 'scalar', value },
  });
  const details = summarizeMeasurementDetails({
    status: 'succeeded',
    coverage: 'complete',
    metrics: {
      requests: scalar(100),
      ttft: scalar(120),
      itl: scalar(15),
      requestLatency: scalar(850),
      outputThroughput: scalar(450),
      totalThroughput: scalar(620),
    },
  });
  assert.equal(
    details?.compact,
    'outputThroughput=450 · totalThroughput=620 · ttft=120 · itl=15 · …',
  );
  assert.equal(
    details?.full,
    'outputThroughput=450 · totalThroughput=620 · ttft=120 · itl=15 · requestLatency=850 · requests=100',
  );
  assert.equal(
    summarizeMeasurement({
      status: 'succeeded',
      coverage: 'complete',
      metrics: {
        referenceMeanMs: scalar(2.5),
        latencyMeanMs: scalar(1.2),
        speedupVsReference: scalar(2.08),
        candidateValid: scalar(1),
      },
    }),
    'speedupVsReference=2.08 · latencyMeanMs=1.20 · candidateValid=1 · referenceMeanMs=2.50',
  );
  assert.equal(
    summarizeCallOutcome(
      'contract.selector-metrics',
      {},
      {
        accepted: true,
        metric: 'successRate',
        incumbentValue: 0.4,
        candidateValue: 0.55,
      },
    ),
    'accepted · successRate 0.4 -> 0.55',
  );
  assert.equal(
    summarizeCallOutcome(
      'contract.proposer',
      {},
      { status: 'no-change', candidateRef: 'candidate-1234', diffRef: null },
    ),
    'no changes',
  );
  assert.equal(
    summarizeCallOutcome(
      'contract.application',
      { action: 'initialize' },
      { initialCandidateRef: 'candidate-8b300ad01234567890' },
    ),
    'candidate candidate-8b300ad0',
  );
  assert.equal(
    summarizeCallOutcome(
      'contract.memory',
      {},
      { status: 'updated', memoryRef: 'm1', changeRef: 'c1', reason: 'ok' },
    ),
    'updated',
  );
});

test('forwardSdkProgress reports task metadata and notice level', () => {
  const updates: CallProgressUpdate[] = [];
  const fakeContext = {
    reportProgress(update: CallProgressUpdate) {
      updates.push(update);
    },
  } as unknown as RuntimeContext;
  const listener = forwardSdkProgress(fakeContext);
  assert.ok(listener);

  listener({
    phase: 'prepare',
    message: 'Preparing solve image and runtime layers',
    taskId: 'workbuddy/furniture-refinish-L3-001',
    summary: { total: 10, prepared: 6, completed: 3 },
    live: {
      id: 'live-1',
      sequence: 1,
      status: 'updated',
      elapsedMs: 12_000,
      idleMs: 0,
      lines: ['Step 1/4: FROM python:3.12', 'Step 2/4: RUN pip install pytest'],
    },
  });
  listener({
    phase: 'verify',
    message: 'Verifier timed out',
    taskId: 'task-04',
    warning: true,
  });

  assert.equal(updates[0]?.detail, '3/10 done (6 prepared)');
  assert.deepEqual(updates[0]?.lines, [
    '[prepare] workbuddy/furniture-refinish-L3-001 (12s)',
  ]);
  assert.equal(updates[0]?.notice, undefined);
  assert.equal(updates[1]?.level, 'warning');
  assert.equal(
    updates[1]?.notice,
    'task-04: evaluator issue · See saved Evaluator diagnostics if available.',
  );
});

type SdkFailure = NonNullable<ProgressEvent['failure']>;

function sdkFailure(
  code: SdkFailure['code'],
  additional: Partial<SdkFailure> = {},
): SdkFailure {
  return {
    ...ERROR_CODES[code],
    phase: 'solve',
    code,
    message: 'private-failure-message',
    schemaVersion: 1,
    severity: 'error',
    retryable: false,
    hint: 'private-event-hint',
    details: {},
    causes: [],
    ...additional,
  };
}

test('Evaluator diagnostics expand safe details in verbose mode without exposing SDK text', () => {
  const attemptId = 'a1234567-89ab-4cde-8fab-0123456789ab';
  for (const [mode, verbose] of [
    ['tty', false],
    ['tty', true],
    ['plain', false],
    ['plain', true],
  ] as const) {
    const { stream, chunks } = makeStream({
      isTTY: mode === 'tty',
      columns: 100,
    });
    const progress = startRunProgress({
      stream,
      recipe: 'fixture.yaml',
      resume: false,
      mode,
      verbose,
      tickMs: 0,
    });
    progress.observe({
      kind: 'experiment-preparing',
      experimentId: 'fixture',
      recipeId: 'fixture',
      policyId: 'fixture',
      resumed: false,
    });
    const call = {
      experimentId: 'fixture',
      callId: 'eval-call',
      parentCallId: 'root',
      bindingId: 'eval',
      bindingRef: 'evaluator.agentbench',
      path: 'steps/eval',
      contractId: 'contract.agentbench',
      revisionRef: null,
    };
    progress.observe({ ...call, kind: 'call', status: 'running' });
    const listener = forwardSdkProgress({
      reportProgress(update: CallProgressUpdate) {
        progress.observe({ ...call, ...update, kind: 'call-progress' });
      },
    } as RuntimeContext)!;
    const event: ProgressEvent = {
      phase: 'solve',
      taskId: 'fixture-task',
      attemptId,
      message: 'private-sdk-message',
      summary: { total: 2, prepared: 1, completed: 1 },
      live: {
        id: 'private-operation-id',
        sequence: 1,
        status: 'started',
        elapsedMs: 12_000,
        idleMs: 0,
        lines: ['private-tool-command', 'private-tool-output'],
      },
      error: true,
      failure: normalizeFailure(
        sdkFailure('SOLVER_RESULT_INCOMPLETE', {
          message: 'DSH turn ended with reason error',
          details: {
            originalName: 'DshProtocolError',
            exitCode: 1,
            logPath: 'private-log-path',
            networkEvidence: 'private-network-evidence',
          },
          causes: [
            {
              message:
                '402: {"message":"Insufficient Balance (request_id: private-request-id)","type":"insufficient_balance_error","code":"invalid_request_error"}',
            },
          ],
        }),
      ),
    };
    const original = structuredClone(event);
    listener({ ...event, error: false });
    listener(event);
    listener(event);
    progress.finish('failed');
    const output = chunks.join('');
    assert.doesNotMatch(
      output,
      /private-|request_id|invalid_request_error|DSH turn ended/,
    );
    if (mode === 'tty' || verbose) {
      assert.match(output, /1\/2 done/);
      assert.match(output, /\[solve\] fixture-task \(12s\)/);
    }
    assert.equal(
      output.match(
        /fixture-task: SOLVER_RESULT_INCOMPLETE · HTTP 402 · Model account has insufficient balance/g,
      )?.length,
      1,
    );
    assert.equal(
      output.includes(
        `phase solve · HTTP 402 · process exit 1 · attempt ${attemptId}`,
      ),
      verbose,
    );
    assert.deepEqual(event, original);
  }
});

test('Evaluator diagnostic summaries distinguish known causes from SDK hints', () => {
  const updates: CallProgressUpdate[] = [];
  const listener = forwardSdkProgress({
    reportProgress(update: CallProgressUpdate) {
      updates.push(update);
    },
  } as RuntimeContext)!;
  function show(failure: SdkFailure) {
    listener({
      phase: failure.phase,
      attemptId: 'private-attempt',
      message: 'private-message',
      failure,
      error: true,
    });
    const update = updates.at(-1)!;
    assert.doesNotMatch(JSON.stringify(update), /private-/);
    return update;
  }
  function dsh(message: string, httpStatus?: number) {
    return sdkFailure('SOLVER_RESULT_INCOMPLETE', {
      details: { originalName: 'DshProtocolError', httpStatus },
      causes: [{ message }],
    });
  }
  for (const [failure, reason] of [
    [
      sdkFailure('MODEL_AUTH_FAILED'),
      'Model API authentication or permissions failed',
    ],
    [
      dsh('402: {"message":"private-payment-detail"}'),
      'HTTP 402 · Payment Required',
    ],
    [
      dsh('HTTP 429: private-throttle'),
      'HTTP 429 · Request rate limit reached',
    ],
    [
      dsh(
        'Error code: 429 - {"error":{"code":"insufficient_quota","message":"private-provider-body"}}',
      ),
      'HTTP 429 · Model quota is exhausted',
    ],
    [
      dsh('402: {"type":"insufficient_balance_error"}', 503),
      'HTTP 503 · Service Unavailable',
    ],
    [
      sdkFailure('ENV_IMAGE_PULL_FAILED', { details: { httpStatus: 401 } }),
      'HTTP 401 · Unauthorized',
    ],
    [
      sdkFailure('NETWORK_FAILURE', {
        details: {
          networkReason: 'response-truncated',
          networkEvidence: 'private-body',
        },
      }),
      'Model response ended before completion',
    ],
    [
      sdkFailure('NETWORK_FAILURE', {
        causes: [{ code: 'ECONNRESET', message: 'private-host' }],
      }),
      'ECONNRESET · Connection reset',
    ],
    [dsh('read ECONNRESET private-host'), 'ECONNRESET · Connection reset'],
    [
      sdkFailure('ENV_IMAGE_BUILD_FAILED', {
        phase: 'prepare',
        causes: [
          {
            message:
              'ENV_RUNTIME_INSTALL_FAILED: private-build-output\n#5 2.4 npm error code ECONNRESET',
          },
        ],
      }),
      'ECONNRESET · Connection reset',
    ],
  ] as const) {
    assert.equal(
      show(failure).notice,
      `${failure.phase}: ${failure.code} · ${reason}`,
    );
  }

  for (const failure of [
    dsh('402: {broken'),
    dsh(
      '402: {"type":"insufficient_balance_error","message":"' +
        'a'.repeat(2048) +
        '"}',
    ),
    sdkFailure('SOLVER_RESULT_INCOMPLETE', {
      message:
        'private-unrelated-error including DSH turn ended with reason error',
      causes: [{ message: '402: {"type":"insufficient_balance_error"}' }],
    }),
    sdkFailure('ENV_IMAGE_BUILD_FAILED', {
      phase: 'prepare',
      details: { exitCode: 1, httpStatus: 900 },
      causes: [{ message: '#1 0.1 RUN echo "npm error code ECONNRESET"' }],
    }),
  ]) {
    assert.equal(
      show(failure).notice,
      `${failure.phase}: ${failure.code} · SDK hint · ${ERROR_CODES[failure.code].hint} See saved Evaluator diagnostics if available.`,
    );
  }
  for (const code of Object.keys(ERROR_CODES) as SdkFailure['code'][]) {
    const notice = show(sdkFailure(code)).notice;
    assert.ok(notice);
    assert.ok(notice.startsWith(`solve: ${code} · `));
    if (ERROR_CODES[code].category !== 'model' || notice.includes('SDK hint')) {
      assert.ok(notice.includes(ERROR_CODES[code].hint));
    }
  }
});

test('sticky TTY renderer keeps status in-place without scrolling spam and prints milestones above', () => {
  const { stream, chunks } = makeStream({
    isTTY: true,
    columns: 60,
    env: { NO_COLOR: '1' },
  });
  const renderer = createTerminalRenderer(stream, 'tty');

  renderer.printMilestone(['Starting recipe.yaml']);
  for (let i = 1; i <= 20; i++) {
    renderer.setStatus([
      `⠋ Running · ${i}.0s · 1 active`,
      `  └─ evaluator (steps/eval) ${i}.0s`,
    ]);
  }
  renderer.printMilestone(['Completed evaluator (steps/eval) 20.0s']);
  renderer.setStatus(['⠋ Running · 21.0s · 1 step']);
  renderer.finish(['Finished exp-1 succeeded in 21.5s']);

  const screen = simulateTerminal(chunks).filter((line) => line.length > 0);
  assert.deepEqual(screen, [
    'Starting recipe.yaml',
    'Completed evaluator (steps/eval) 20.0s',
    'Finished exp-1 succeeded in 21.5s',
  ]);
});

test('progress fits a 16-column terminal and stops after a write failure', () => {
  const { stream, chunks } = makeStream({
    columns: 16,
    env: { NO_COLOR: '1' },
  });
  const renderer = createTerminalRenderer(stream, 'tty');
  renderer.setStatus(['abcdefghijklmnopqrstuvwxyz']);
  assert.equal(chunks[0], 'abcdefghijklmn…');
  renderer.setStatus(['⌚'.repeat(10)]);
  assert.equal(chunks[1], '\r\x1b[J' + '⌚'.repeat(7) + '…');
  renderer.setStatus(['short']);
  renderer.finish([]);
  assert.deepEqual(simulateTerminal(chunks), ['']);

  let writes = 0;
  const broken = createTerminalRenderer(
    {
      isTTY: false,
      write() {
        writes++;
        throw new Error('closed pipe');
      },
    },
    'plain',
  );
  broken.printMilestone(['first']);
  broken.printMilestone(['second']);
  broken.finish(['final']);
  assert.equal(writes, 1);
});

test('Agent progress tracks concurrent tools by ID and excludes trace content', async (t) => {
  const f = await agentFixture();
  t.after(f.close);
  const updates: CallProgressUpdate[] = [];
  await f.execute(
    {
      async execute(_input, ctx) {
        ctx.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: {
            type: 'message.completed',
            messageId: 'one',
            role: 'assistant',
            text: 'private-reply',
          },
        });
        for (const [toolCallId, name] of [
          ['a', 'read'],
          ['b', 'search'],
        ] as const) {
          ctx.event.emit('rsi/agent-observation', {
            runId: 'main',
            event: {
              type: 'tool.started',
              toolCallId,
              name,
              input: { command: 'private-command', query: 'private-query' },
            },
          });
        }
        ctx.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: {
            type: 'tool.completed',
            toolCallId: 'a',
            status: 'succeeded',
            output: 'private-result',
          },
        });
        return { answer: 'fixture' };
      },
      async dispose() {},
    },
    f.request,
    f.context.extend({
      reportProgress(update) {
        updates.push(update);
      },
    }),
  );
  assert.doesNotMatch(JSON.stringify(updates), /private-/);
  assert.deepEqual(updates.at(-1)?.lines, [
    'tool: search',
    'last: read (succeeded)',
  ]);
});

test('Evaluator progress groups live work by task and respects explicit severity', () => {
  const updates: CallProgressUpdate[] = [];
  const listener = forwardSdkProgress({
    reportProgress(update: CallProgressUpdate) {
      updates.push(update);
    },
  } as RuntimeContext)!;
  const task = {
    phase: 'execution',
    taskId: 'fixture-task',
    message: 'running',
  };
  const live = {
    id: 'attempt',
    sequence: 1,
    status: 'started' as const,
    elapsedMs: 0,
    idleMs: 0,
    lines: [],
  };
  listener(task);
  listener({ ...task, live });
  listener({ ...task, live: { ...live, id: 'child', parentId: live.id } });
  assert.equal(
    updates.at(-1)?.lines?.filter((line) => line.includes('fixture-task'))
      .length,
    1,
  );
  listener({
    ...task,
    live: { ...live, id: 'child', sequence: 2, status: 'completed' },
  });
  assert.match(updates.at(-1)?.lines?.[0] ?? '', /fixture-task/);
  listener({ ...task, live: { ...live, sequence: 2, status: 'completed' } });
  listener({ ...task, message: 'Finished successfully' });
  assert.deepEqual(updates.at(-1)?.lines, []);

  listener({
    ...task,
    error: false,
    message: 'scored timeout',
    failure: {
      phase: 'solve',
      code: 'SOLVER_AGENT_TIMEOUT',
      message: 'timeout',
      schemaVersion: 1,
      category: 'solver',
      scope: 'attempt',
      severity: 'error',
      retryable: false,
      action: 'finalize',
      hint: '',
      details: {},
      causes: [],
    },
  });
  assert.equal(updates.at(-1)?.level, undefined);
  assert.equal(updates.at(-1)?.notice, undefined);
});

test('run progress rolls nested agent activity and failures into owning calls without duplicate errors', () => {
  let clock = 0;
  const reportedErrors: string[] = [];
  const { stream, chunks } = makeStream({
    isTTY: true,
    columns: 100,
    env: { NO_COLOR: '1' },
  });
  const progress = startRunProgress({
    stream,
    recipe: 'demo/recipe.yaml',
    id: 'exp-1',
    resume: true,
    mode: 'tty',
    tickMs: 0,
    now: () => clock,
    onErrorReported: (msg) => reportedErrors.push(msg),
  });

  progress.observe({
    kind: 'experiment-preparing',
    experimentId: 'exp-1',
    recipeId: 'recipe-1',
    policyId: 'policy.wikiskill',
    resumed: true,
  });
  progress.observe({
    kind: 'experiment-resumed',
    experimentId: 'exp-1',
    reusedCalls: [
      { bindingId: '_application', path: 'initialize' },
      { bindingId: 'evaluator', path: 'steps/baseline' },
      { bindingId: 'evaluator', path: 'steps/search/iteration-0/train' },
    ],
    priorUsage: { operations: 9, evaluationRuns: 2 },
  });

  // Start top-level proposer and nested agent call.
  progress.observe({
    kind: 'call',
    contractId: 'contract.proposer',
    status: 'running',
    experimentId: 'exp-1',
    callId: 'call-proposer',
    bindingId: 'proposer',
    parentCallId: 'root',
    path: 'steps/search/iteration-0/propose',
    bindingRef: 'proposer.agent',
    revisionRef: null,
  });
  progress.observe({
    kind: 'call',
    contractId: 'contract.agent',
    status: 'running',
    experimentId: 'exp-1',
    callId: 'call-agent-uuid',
    bindingId: 'agent',
    parentCallId: 'call-proposer',
    path: 'call-1234567890abcdef1234567890abcdef',
    bindingRef: 'agent.pi',
    revisionRef: null,
  });
  clock += 5000;
  progress.observe({
    kind: 'call-progress',
    callId: 'call-agent-uuid',
    parentCallId: 'call-proposer',
    bindingId: 'agent',
    path: 'call-1234567890abcdef1234567890abcdef',
    contractId: 'contract.agent',
    detail: 'claude-sonnet · turn 2 · 3 tools',
    lines: [
      'tool: edit_file  skills/office/SKILL.md',
      'Updating workflow rules',
    ],
  });

  // Nested agent detail and multi-line sub-panel must appear on the owning proposer in the sticky bar.
  const midScreen = simulateTerminal(chunks).join('\n');
  assert.match(
    midScreen,
    /proposer \(search\/iteration-0\/propose\).*claude-sonnet · turn 2 · 3 tools/,
  );
  assert.match(midScreen, /│ tool: edit_file skills\/office\/SKILL\.md/);
  assert.match(midScreen, /│ Updating workflow rules/);

  // Nested agent fails, then bubbles exact same error to proposer: error must appear ONCE.
  const sharedError = 'Agent final response must be a JSON object';
  clock += 2000;
  progress.observe({
    kind: 'call',
    contractId: 'contract.agent',
    status: 'failed',
    experimentId: 'exp-1',
    callId: 'call-agent-uuid',
    bindingId: 'agent',
    parentCallId: 'call-proposer',
    path: 'call-1234567890abcdef1234567890abcdef',
    bindingRef: 'agent.pi',
    revisionRef: null,
    error: sharedError,
  });
  progress.observe({
    kind: 'call',
    contractId: 'contract.proposer',
    status: 'failed',
    experimentId: 'exp-1',
    callId: 'call-proposer',
    bindingId: 'proposer',
    parentCallId: 'root',
    path: 'steps/search/iteration-0/propose',
    bindingRef: 'proposer.agent',
    revisionRef: null,
    error: sharedError,
  });
  progress.observe({ kind: 'experiment-cleaning' });
  const cleaningScreen = simulateTerminal(chunks).join('\n');
  assert.match(cleaningScreen, /Cleaning up/);

  progress.observe({
    kind: 'experiment-finished',
    experimentId: 'exp-1',
    status: 'failed',
    reused: false,
    usage: { operations: 11 },
    partial: false,
  });
  progress.finish('failed');

  const finalScreen = simulateTerminal(chunks).join('\n');
  assert.match(
    finalScreen,
    /Reused\s+3 completed calls \(initialize, evaluator \(baseline\), evaluator \(search\/iteration-0\/train\)\)/,
  );
  assert.match(finalScreen, /Prior\s+operations=9 evaluationRuns=2/);
  assert.doesNotMatch(finalScreen, /call-1234567890abcdef/);
  assert.equal(finalScreen.split(sharedError).length - 1, 1);
  assert.deepEqual(reportedErrors, [sharedError]);
});

test('run progress caps visible active calls, suppresses default steps, and prints outcomes and revisions', () => {
  let clock = 0;
  const { stream, chunks } = makeStream({
    isTTY: true,
    columns: 70,
    env: { NO_COLOR: '1' },
  });
  const progress = startRunProgress({
    stream,
    recipe: 'demo/recipe.yaml',
    id: 'exp-1',
    resume: false,
    mode: 'tty',
    tickMs: 0,
    now: () => clock,
  });

  progress.observe({
    kind: 'experiment-preparing',
    experimentId: 'exp-1',
    recipeId: 'recipe-1',
    policyId: 'evo-v1',
    resumed: false,
  });

  for (let i = 1; i <= 6; i++) {
    clock += 1000;
    progress.observe({
      kind: 'call',
      contractId: 'contract.agentbench',
      status: 'running',
      experimentId: 'exp-1',
      callId: `call-${i}`,
      bindingId: `worker-${i}`,
      parentCallId: 'root',
      path: `steps/parallel/${i}`,
      bindingRef: `ref-${i}`,
      revisionRef: null,
    });
  }

  const midScreen = simulateTerminal(chunks);
  assert.ok(midScreen.some((line) => line.includes('6 active')));
  assert.ok(midScreen.some((line) => line.includes('+2 more active')));
  for (const line of midScreen) {
    assert.ok(line.length <= 69, `line exceeded terminal width: ${line}`);
  }

  progress.observe({ kind: 'step-completed', stepPath: 'steps/internal' });
  progress.observe({
    kind: 'call',
    contractId: 'contract.agentbench',
    status: 'succeeded',
    experimentId: 'exp-1',
    callId: 'call-1',
    bindingId: 'worker-1',
    parentCallId: 'root',
    path: 'steps/parallel/1',
    bindingRef: 'ref-1',
    revisionRef: null,
    summary: 'm1=1 · m2=2 · m3=3 · m4=4 · …',
    verboseSummary: 'm1=1 · m2=2 · m3=3 · m4=4 · m5=5',
  });
  progress.observe({
    kind: 'revision-activated',
    activationId: 'act-1',
    bindingIds: ['proposer', 'memoryUpdater'],
  });
  progress.observe({
    kind: 'experiment-finished',
    experimentId: 'exp-1',
    status: 'succeeded',
    reused: false,
    usage: { operations: 6 },
    partial: false,
  });
  progress.finish('succeeded');
  const countAfterFinish = chunks.length;
  progress.finish('succeeded');
  assert.equal(chunks.length, countAfterFinish);

  const finalScreen = simulateTerminal(chunks).join('\n');
  assert.doesNotMatch(finalScreen, /steps\/internal/);
  assert.doesNotMatch(finalScreen, /\+2 more active/);
  assert.match(
    finalScreen,
    /Completed\s+worker-1 \(parallel\/1\).*m1=1 · m2=2 · m3=3 · m4=4 · …/,
  );
  assert.doesNotMatch(finalScreen, /m5=5/);

  // Verbose mode shows all available metrics without truncation.
  const vStream = makeStream({ isTTY: false });
  const vProgress = startRunProgress({
    stream: vStream.stream,
    recipe: 'demo/recipe.yaml',
    id: 'exp-v',
    resume: false,
    mode: 'plain',
    verbose: true,
    plainHeartbeatMs: 0,
    now: () => 0,
  });
  vProgress.observe({
    kind: 'call',
    contractId: 'contract.inferencebench',
    status: 'succeeded',
    experimentId: 'exp-v',
    callId: 'call-v1',
    bindingId: 'evaluator',
    parentCallId: 'root',
    path: 'steps/eval',
    bindingRef: 'evaluator.inferencebench',
    revisionRef: null,
    summary: 'm1=1 · m2=2 · m3=3 · m4=4 · …',
    verboseSummary: 'm1=1 · m2=2 · m3=3 · m4=4 · m5=5',
  });
  vProgress.finish('succeeded');
  assert.match(vStream.chunks.join(''), /m1=1 · m2=2 · m3=3 · m4=4 · m5=5/);
  assert.match(
    finalScreen,
    /Revised\s+activated revision for proposer, memoryUpdater/,
  );
  assert.match(finalScreen, /Finished\s+exp-1 succeeded/);
});

test('plain mode emits zero ANSI escapes and stays quiet until events or slow heartbeat', () => {
  let clock = 0;
  const { stream, chunks } = makeStream({
    isTTY: false,
    env: {},
  });
  const progress = startRunProgress({
    stream,
    recipe: 'demo/recipe.yaml',
    id: 'exp-plain',
    resume: false,
    mode: 'auto',
    plainHeartbeatMs: 0,
    now: () => clock,
  });
  assert.equal(progress.mode, 'plain');

  progress.observe({
    kind: 'experiment-preparing',
    experimentId: 'exp-plain',
    recipeId: 'r1',
    policyId: 'p1',
    resumed: false,
  });
  progress.observe({ kind: 'step-completed', stepPath: 'steps/hidden' });
  progress.observe({
    kind: 'iteration-completed',
    stepPath: 'steps/loop',
    iteration: 0,
  });
  clock = 5_000;
  progress.observe({
    kind: 'experiment-finished',
    experimentId: 'exp-plain',
    status: 'succeeded',
    reused: false,
    usage: { operations: 1 },
    partial: false,
  });
  progress.finish('succeeded');

  const raw = chunks.join('');
  assert.doesNotMatch(raw, /\x1b\[/);
  assert.doesNotMatch(raw, /steps\/hidden/);
  assert.match(raw, /Completed round 1 \(steps\/loop\)/);
  assert.match(raw, /Experiment exp-plain succeeded/);
});

test('doctor progress renders binding milestones, live probe details, failures, and summary in TTY and plain modes', () => {
  let clock = 0;
  const { stream, chunks } = makeStream({
    isTTY: true,
    columns: 90,
    env: { NO_COLOR: '1' },
  });
  const doctor = startDoctorProgress({
    stream,
    recipe: 'demo/recipe.yaml',
    staticOnly: false,
    mode: 'tty',
    tickMs: 0,
    now: () => clock,
  });

  doctor.observe({
    kind: 'recipe-validated',
    recipeId: 'demo-recipe',
    totalBindings: 2,
  });
  doctor.observe({
    kind: 'binding-started',
    index: 0,
    total: 2,
    binding: 'evaluator',
    pluginId: 'evaluator.agentbench',
  });
  clock += 3_000;
  doctor.observe({
    kind: 'binding-detail',
    binding: 'evaluator',
    pluginId: 'evaluator.agentbench',
    detail: 'running evaluator SDK probes',
  });
  const liveScreen = simulateTerminal(chunks).join('\n');
  assert.match(liveScreen, /Checking · 3\.0s · 0\/2 bindings/);
  assert.match(
    liveScreen,
    /evaluator \(evaluator\.agentbench\) 3\.0s · running evaluator SDK probes/,
  );

  clock += 2_000;
  doctor.observe({
    kind: 'binding-completed',
    index: 0,
    total: 2,
    binding: 'evaluator',
    pluginId: 'evaluator.agentbench',
    passed: 1,
    failed: 1,
    unchecked: 0,
    checks: [
      { id: 'evaluator.configuration', status: 'passed' },
      {
        id: 'evaluator.sdk.network',
        status: 'failed',
        reason: 'Docker daemon unavailable',
      },
    ],
  });
  doctor.observe({ kind: 'cleaning' });
  assert.match(simulateTerminal(chunks).join('\n'), /Cleaning up/);

  doctor.observe({
    kind: 'finished',
    report: {
      recipeId: 'demo-recipe',
      summary: { passed: 2, failed: 1, unchecked: 0 },
      checks: [
        { id: 'recipe.validate', status: 'passed' },
        {
          id: 'evaluator.sdk.network',
          binding: 'evaluator',
          status: 'failed',
          reason: 'Docker daemon unavailable',
        },
      ],
      missingResources: [
        {
          binding: 'proposer',
          pluginId: 'proposer.agent',
          field: 'proposer.config.prompt',
          kind: 'file',
          reference: '/tmp/missing.md',
          checksNotRun: ['proposer.prompt'],
        },
      ],
    },
  });
  doctor.finish('completed');

  const finalScreen = simulateTerminal(chunks).join('\n');
  assert.match(finalScreen, /Validated\s+demo-recipe \(2 bindings\)/);
  assert.match(
    finalScreen,
    /Failed\s+evaluator \(evaluator\.agentbench\) 5\.0s · 1 passed · 1 failed/,
  );
  assert.match(
    finalScreen,
    /evaluator\.sdk\.network: Docker daemon unavailable/,
  );
  assert.doesNotMatch(finalScreen, /evaluator\.configuration/);
  assert.match(finalScreen, /Summary\s+2 passed · 1 failed · 0 unchecked/);
  assert.match(finalScreen, /Missing\s+1 missing resource/);

  // Plain mode emits zero ANSI escapes and surfaces top-level recipe failures.
  const plain = makeStream({ isTTY: false });
  const plainDoctor = startDoctorProgress({
    stream: plain.stream,
    recipe: 'bad/recipe.yaml',
    staticOnly: true,
    mode: 'auto',
    now: () => 0,
  });
  assert.equal(plainDoctor.mode, 'plain');
  plainDoctor.observe({
    kind: 'finished',
    report: {
      recipeId: null,
      summary: { passed: 0, failed: 1, unchecked: 0 },
      checks: [
        {
          id: 'recipe.validate',
          status: 'failed',
          reason: 'ENOENT: bad/recipe.yaml',
        },
      ],
      missingResources: [],
    },
  });
  plainDoctor.finish('completed');
  const rawPlain = plain.chunks.join('');
  assert.doesNotMatch(rawPlain, /\x1b\[/);
  assert.match(rawPlain, /Failed recipe\.validate: ENOENT: bad\/recipe\.yaml/);
  assert.match(rawPlain, /Summary 0 passed · 1 failed · 0 unchecked/);
});

test('startCleanupProgress renders single-experiment and workspace progress in TTY and plain modes', () => {
  // 1. Single experiment in TTY mode.
  const { stream, chunks } = makeStream({
    isTTY: true,
    columns: 100,
    env: { NO_COLOR: '1' },
  });
  let clock = 0;
  const single = startCleanupProgress({
    stream,
    scope: 'experiment',
    experimentId: 'exp-clean-01',
    dryRun: false,
    mode: 'auto',
    tickMs: 0,
    now: () => clock,
  });
  assert.equal(single.mode, 'tty');

  single.observe({
    kind: 'experiment-started',
    experimentId: 'exp-clean-01',
    index: 0,
    total: 1,
  });
  single.observe({
    kind: 'bindings-discovered',
    experimentId: 'exp-clean-01',
    totalBindings: 2,
  });
  single.observe({
    kind: 'binding-started',
    experimentId: 'exp-clean-01',
    index: 0,
    total: 2,
    bindingId: 'evaluator',
    pluginId: 'evaluator.agentbench',
  });
  clock += 2_500;
  single.observe({
    kind: 'binding-detail',
    experimentId: 'exp-clean-01',
    bindingId: 'evaluator',
    pluginId: 'evaluator.agentbench',
    detail: 'cleaning receipt 1/2 (call-12345678)',
  });
  const liveSingle = simulateTerminal(chunks).join('\n');
  assert.match(liveSingle, /Cleaning exp-clean-01 · 2\.5s · 0\/2 bindings/);
  assert.match(
    liveSingle,
    /evaluator \(evaluator\.agentbench\) 2\.5s · cleaning receipt 1\/2 \(call-12345678\)/,
  );

  clock += 1_500;
  const evalResults = [
    {
      bindingId: 'evaluator',
      pluginId: 'evaluator.agentbench',
      key: 'call-12345678',
      status: 'complete' as const,
      report: {
        preview: false,
        nodes: [
          {
            nodeId: 'local',
            daemonId: 'd1',
            items: [
              {
                reference: 'img:1',
                imageId: 'a',
                status: 'deleted',
                reason: '',
              },
              {
                reference: 'img:2',
                imageId: 'b',
                status: 'retained',
                reason: '',
              },
            ],
          },
        ],
      },
    },
    {
      bindingId: 'evaluator',
      pluginId: 'evaluator.agentbench',
      key: 'call-87654321',
      status: 'pending' as const,
      error: 'Docker daemon unavailable',
    },
  ];
  single.observe({
    kind: 'binding-completed',
    experimentId: 'exp-clean-01',
    index: 0,
    total: 2,
    bindingId: 'evaluator',
    pluginId: 'evaluator.agentbench',
    results: evalResults,
    handled: true,
  });
  single.observe({
    kind: 'binding-started',
    experimentId: 'exp-clean-01',
    index: 1,
    total: 2,
    bindingId: 'proposer',
    pluginId: 'proposer.agent',
  });
  single.observe({
    kind: 'binding-completed',
    experimentId: 'exp-clean-01',
    index: 1,
    total: 2,
    bindingId: 'proposer',
    pluginId: 'proposer.agent',
    results: [],
    handled: false,
  });
  single.observe({
    kind: 'finished',
    scope: 'experiment',
    report: {
      experimentId: 'exp-clean-01',
      dryRun: false,
      results: evalResults,
    },
  });
  single.finish('completed');

  const finalSingle = simulateTerminal(chunks).join('\n');
  assert.match(finalSingle, /Cleaning\s+exp-clean-01/);
  assert.match(
    finalSingle,
    /Pending\s+evaluator \(evaluator\.agentbench\) 4\.0s · 1\/2 pending · 1 deleted · 1 retained/,
  );
  assert.match(finalSingle, /call-87654321: Docker daemon unavailable/);
  assert.doesNotMatch(finalSingle, /no cleanup handler/);
  assert.match(
    finalSingle,
    /Summary\s+pending · 1\/2 pending · 1 deleted · 1 retained in 4\.0s/,
  );

  // 2. Workspace preview in TTY mode with multi-line sticky panel.
  const ws = makeStream({ isTTY: true, env: { NO_COLOR: '1' } });
  let wsClock = 0;
  const workspace = startCleanupProgress({
    stream: ws.stream,
    scope: 'workspace',
    dryRun: true,
    mode: 'auto',
    tickMs: 0,
    now: () => wsClock,
  });
  workspace.observe({ kind: 'experiments-discovered', totalExperiments: 2 });
  workspace.observe({
    kind: 'experiment-started',
    experimentId: 'exp-a',
    index: 0,
    total: 2,
  });
  workspace.observe({
    kind: 'bindings-discovered',
    experimentId: 'exp-a',
    totalBindings: 1,
  });
  workspace.observe({
    kind: 'binding-started',
    experimentId: 'exp-a',
    index: 0,
    total: 1,
    bindingId: 'evaluator',
    pluginId: 'evaluator.operatorbench',
  });
  wsClock += 1_200;
  workspace.observe({
    kind: 'binding-detail',
    experimentId: 'exp-a',
    bindingId: 'evaluator',
    pluginId: 'evaluator.operatorbench',
    detail: 'previewing receipt 1/1 (call-abcdef01)',
  });
  const liveWs = simulateTerminal(ws.chunks).join('\n');
  assert.match(liveWs, /Previewing workspace · 1\.2s · 0\/2 experiments/);
  assert.match(liveWs, /exp-a · 1\.2s · 0\/1 bindings/);
  assert.match(
    liveWs,
    /evaluator \(evaluator\.operatorbench\) 1\.2s · previewing receipt 1\/1/,
  );

  const previewEntry = {
    experimentId: 'exp-a',
    status: 'preview' as const,
    results: [
      {
        bindingId: 'evaluator',
        pluginId: 'evaluator.operatorbench',
        key: 'call-abcdef01',
        status: 'preview' as const,
        report: {
          preview: true,
          nodes: [
            {
              nodeId: 'local',
              daemonId: 'd1',
              items: [
                {
                  reference: 'img:1',
                  imageId: 'a',
                  status: 'candidate',
                  reason: '',
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const skippedEntry = {
    experimentId: 'exp-b',
    status: 'skipped' as const,
    reason: 'Experiment exp-b is in use',
    results: [],
  };
  workspace.observe({
    kind: 'experiment-completed',
    index: 0,
    total: 2,
    entry: previewEntry,
  });
  workspace.observe({
    kind: 'experiment-started',
    experimentId: 'exp-b',
    index: 1,
    total: 2,
  });
  workspace.observe({
    kind: 'experiment-completed',
    index: 1,
    total: 2,
    entry: skippedEntry,
  });
  workspace.observe({
    kind: 'finished',
    scope: 'workspace',
    report: { dryRun: true, experiments: [previewEntry, skippedEntry] },
  });
  workspace.finish('completed');

  const finalWs = simulateTerminal(ws.chunks).join('\n');
  assert.match(finalWs, /Preview\s+exp-a 1\.2s · 1 receipt · 1 candidate/);
  assert.match(finalWs, /Skipped\s+exp-b · Experiment exp-b is in use/);
  assert.match(
    finalWs,
    /Summary\s+2 experiments \(1 preview · 1 skipped\) · 1 candidate/,
  );

  // 3. Plain mode emits zero ANSI escapes and reports errors for deduplication.
  const plain = makeStream({ isTTY: false });
  const reportedErrors: string[] = [];
  const plainCleanup = startCleanupProgress({
    stream: plain.stream,
    scope: 'experiment',
    experimentId: 'missing-exp',
    dryRun: false,
    mode: 'auto',
    now: () => 0,
    onErrorReported: (msg) => reportedErrors.push(msg),
  });
  assert.equal(plainCleanup.mode, 'plain');
  plainCleanup.finish('failed', 'Experiment missing-exp not found');
  const rawPlainCleanup = plain.chunks.join('');
  assert.doesNotMatch(rawPlainCleanup, /\x1b\[/);
  assert.match(rawPlainCleanup, /Cleaning experiment missing-exp/);
  assert.match(
    rawPlainCleanup,
    /Cleanup failed: Experiment missing-exp not found/,
  );
  assert.deepEqual(reportedErrors, ['Experiment missing-exp not found']);
});
