import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RuntimeContext,
  type AgentInput,
  type JsonObject,
} from '../../src/contracts/index.js';
import { createScriptedAgent } from '../../src/plugins/agent-scripted/service.js';
import { editOutputSchema } from '../../src/plugins/shared/agent-editing/index.js';
import { object } from '../../src/shared/json.js';

const baseline = '# original source\ndef kernel_function():\n    return 1\n';
const repaired = '# repaired source\ndef kernel_function():\n    return 2\n';
const sourceDigest = (source: string): string =>
  createHash('sha256').update(source, 'utf8').digest('hex');

function response(
  codes: string[],
  result: JsonObject,
  excludedDiagnosticCodes: string[] = [],
): JsonObject {
  return {
    sourceDigest: sourceDigest(baseline),
    requiredDiagnosticCodes: codes,
    excludedDiagnosticCodes,
    response: result,
  };
}

function evidence(codes: string[], ref = 'measurement-1'): JsonObject {
  return {
    schemaVersion: 'rsi.evidence-view/v1',
    view: 'training-summary',
    measurements: [
      {
        measurementRef: ref,
        items: [
          {
            id: 'case-1',
            evaluation: {
              schemaVersion: 'rsi.evaluation-feedback/v1',
              itemId: 'case-1',
              attemptId: null,
              executionStatus: 'compile-failed',
              scoreStatus: 'invalid',
              passed: false,
              primaryReward: null,
              passThreshold: null,
              checks: [],
              checksComplete: true,
              diagnostics: codes.map((code) => ({
                kind: 'compile',
                code,
                message: 'Observed candidate diagnostic.',
                source: { artifactRef: 'artifact:diagnostic', pointer: '' },
                truncated: false,
              })),
              truncated: false,
              source: { artifactRef: 'artifact:result', pointer: '' },
            },
          },
        ],
      },
    ],
  };
}

async function fixture(responses: JsonObject[]) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-scripted-agent-'));
  const path = join(root, 'responses.json');
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 'rsi.scripted-agent/v1', responses }),
  );
  const charges: [string, number][] = [];
  const services = new RuntimeContext().extend({
    charge: async (metric: string, amount: number): Promise<void> => {
      charges.push([metric, amount]);
    },
  });
  const controller = new AbortController();
  const context = services.extend({
    experimentId: 'experiment',
    callId: 'call-1',
    bindingId: 'agent',
    idempotencyKey: 'call-1',
    directory: root,
    signal: controller.signal,
    cleanup: new AbortController().signal,
  });
  const operation = await createScriptedAgent({ responses: path }, services);
  // Build the managed workspace the new agent contract delivers: editable
  // files under candidate/, the evidence view in context/measurements.json.
  let workspaces = 0;
  const workspace = async (
    evidenceDoc: JsonObject,
    source = baseline,
  ): Promise<AgentInput> => {
    const cwd = join(root, `workspace-${workspaces++}`);
    await mkdir(join(cwd, 'candidate'), { recursive: true });
    await mkdir(join(cwd, 'context'), { recursive: true });
    await writeFile(join(cwd, 'candidate/input.py'), source);
    await writeFile(
      join(cwd, 'context/measurements.json'),
      JSON.stringify(evidenceDoc),
    );
    await writeFile(join(cwd, 'AGENTS.md'), 'Apply the requested edit.');
    return {
      goal: 'Optimize the supplied source.',
      cwd,
      outputSchema: object(editOutputSchema),
    };
  };
  const request = await workspace(evidence([]));
  return {
    path,
    charges,
    request,
    workspace,
    controller,
    context,
    run: (input: AgentInput = request) => operation.execute(input, context),
    async close(): Promise<void> {
      await operation.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('scripted Agent matches source bytes and semantic feedback with no model or token charges', async () => {
  const f = await fixture([
    response([], { edits: [], reason: 'Initial no change.' }, [
      'COMPILE_ERROR',
    ]),
    response(['COMPILE_ERROR'], {
      edits: [{ path: 'input.py', content: repaired }],
      reason: 'Repair the reported compile error.',
    }),
  ]);
  try {
    assert.deepEqual(
      await f.run(await f.workspace(evidence(['COMPILE_ERROR']))),
      {
        edits: [{ path: 'input.py', content: repaired }],
        reason: 'Repair the reported compile error.',
      },
    );
    assert.deepEqual(f.charges, []);
    await assert.rejects(
      f.run(await f.workspace(evidence([]), `${baseline}\n`)),
      /matched 0 responses/,
    );
  } finally {
    await f.close();
  }
});

test('scripted Agent repeats no-change deterministically across calls and generated evidence identities', async () => {
  const f = await fixture([
    response(['PERF_NO_GAIN'], {
      edits: [],
      reason: 'No further supported edit.',
    }),
  ]);
  try {
    const first = await f.run(await f.workspace(evidence(['PERF_NO_GAIN'])));
    first.reason = 'A caller mutated the returned value.';
    object(first).edits = [{ path: 'input.py', content: 'wrong' }];
    assert.deepEqual(
      await f.run(
        await f.workspace(evidence(['PERF_NO_GAIN'], 'measurement-2')),
      ),
      { edits: [], reason: 'No further supported edit.' },
    );
    assert.deepEqual(f.charges, []);
  } finally {
    await f.close();
  }
});

test('scripted Agent rejects zero matches and ambiguous matching responses', async () => {
  for (const entries of [
    [response(['COMPILE_ERROR'], { edits: [], reason: 'Needs feedback.' })],
    [
      response([], { edits: [], reason: 'First response.' }),
      response([], { edits: [], reason: 'Second response.' }),
    ],
  ]) {
    const f = await fixture(entries);
    try {
      await assert.rejects(
        f.run(),
        entries.length === 1 ? /matched 0 responses/ : /matched 2 responses/,
      );
    } finally {
      await f.close();
    }
  }
});

test('scripted Agent validates the chosen response against the caller output Schema', async () => {
  const f = await fixture([
    response([], {
      edits: [{ path: 'input.py', content: 12 }],
      reason: 'Invalid edit content.',
    }),
  ]);
  try {
    await assert.rejects(
      f.run(),
      /scripted Agent output.*content.*string|null/,
    );
    await assert.rejects(
      f.run({ ...f.request, outputSchema: { type: 'invalid-type' } }),
      /outputSchema.*invalid JSON Schema/,
    );
  } finally {
    await f.close();
  }
});

test('scripted Agent ignores diagnostic-looking text outside normalized training feedback', async () => {
  const f = await fixture([
    response([], { edits: [], reason: 'No diagnostic was supplied.' }, [
      'COMPILE_ERROR',
    ]),
    response(['COMPILE_ERROR'], {
      edits: [],
      reason: 'A diagnostic was supplied.',
    }),
  ]);
  try {
    assert.deepEqual(await f.run(await f.workspace(evidence([]))), {
      edits: [],
      reason: 'No diagnostic was supplied.',
    });
    await assert.rejects(
      f.run(
        await f.workspace({
          ...evidence(['COMPILE_ERROR']),
          view: 'execution',
        }),
      ),
      /training-summary/,
    );
  } finally {
    await f.close();
  }
});

test('scripted Agent honors cancellation before selecting a fixture response', async () => {
  const f = await fixture([response([], { edits: [], reason: 'No change.' })]);
  try {
    f.controller.abort(new Error('Scripted test cancelled'));
    await assert.rejects(f.run(), /Scripted test cancelled/);
    assert.deepEqual(f.charges, []);
  } finally {
    await f.close();
  }
});

test('scripted Agent rejects malformed fixture JSON and invalid fixture identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-scripted-agent-invalid-'));
  const path = join(root, 'responses.json');
  try {
    await writeFile(path, '{broken');
    await assert.rejects(
      createScriptedAgent({ responses: path }, new RuntimeContext()),
      /JSON/,
    );
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 'rsi.scripted-agent/v1',
        responses: [{ ...response([], {}), sourceDigest: 'invalid' }],
      }),
    );
    await assert.rejects(
      createScriptedAgent({ responses: path }, new RuntimeContext()),
      /sourceDigest/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
