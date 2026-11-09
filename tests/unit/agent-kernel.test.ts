import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { kernelDefinition } from '../../src/plugins/agent-kernel/index.js';
import { createAgentKernel } from '../../src/plugins/agent-kernel/service.js';
import type { AgentKernelConfig } from '../../src/plugins/agent-kernel/schema.js';
import { validate } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';

const outputSchema: JsonObject = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: ['string', 'null'] },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
  },
  required: ['edits', 'reason'],
  additionalProperties: false,
};

interface Fixture {
  root: string;
  workspace: string;
  config: AgentKernelConfig;
  charges: number[];
}

async function fixture(mode = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-kernel-'));
  // Managed agent workspace: editable files under candidate/, the composed
  // prompt in AGENTS.md, caller metadata and evidence in context/*.json.
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'candidate/kernels'), { recursive: true });
  await mkdir(join(workspace, 'context'), { recursive: true });
  await writeFile(
    join(workspace, 'candidate/kernels/vector_add.py'),
    'baseline = True\n',
  );
  await writeFile(join(workspace, 'AGENTS.md'), 'base prompt');
  await writeFile(
    join(workspace, 'context/input.json'),
    JSON.stringify({ editConstraints: { bottleneck: 'memory' } }),
  );
  await writeFile(
    join(workspace, 'context/measurements.json'),
    JSON.stringify({ schemaVersion: 'rsi.evidence-view/v1' }),
  );
  const stub = join(root, 'bridge.mjs');
  await writeFile(
    stub,
    `import {writeFile} from 'node:fs/promises';
let text='';for await(const chunk of process.stdin)text+=chunk;
const r=JSON.parse(text), d={root:${JSON.stringify(root)}};
await writeFile(d.root+'/request.json', JSON.stringify({
  request: r,
  tokenForwarded: process.env.AGENT_KERNEL_TEST_TOKEN === 'bridge-secret',
}));
const mode = ${JSON.stringify(mode)};
if (mode==='exit') { process.stderr.write('internal bridge diagnostics'); process.exit(7); }
if (mode==='error-json') { process.stdout.write(JSON.stringify({error: 'model budget exhausted before a proposal'})); process.exit(1); }
if (mode==='garbage') { process.stdout.write('not json'); process.exit(0); }
const calls = mode==='over-budget' ? 99 : 2;
const body = {edits:[{path:'kernels/vector_add.py', content:'optimized = True\\n'}], reason:'rewrote kernel', modelCalls: calls};
if (mode==='missing-calls') delete body.modelCalls;
if (mode==='schema-violation') body.reason = 42;
process.stdout.write(JSON.stringify(body));`,
  );
  const config: AgentKernelConfig = {
    script: stub,
    executable: process.execPath,
    timeoutMs: 30000,
  };
  return {
    root,
    workspace,
    config,
    charges: [],
  };
}

function contextFor(f: Fixture): RuntimeContext {
  return new RuntimeContext().extend({
    signal: new AbortController().signal,
    charge: async (_metric, amount) => {
      f.charges.push(amount);
    },
  });
}

const request = (f: Fixture): JsonObject => ({
  goal: 'Optimize the captured kernel',
  cwd: f.workspace,
  outputSchema,
});

test('agent-kernel schema accepts the bridge config only', async () => {
  const f = await fixture();
  try {
    validate(kernelDefinition.configSchema, f.config, 'config');
    await assert.rejects(
      Promise.resolve().then(() =>
        validate(
          kernelDefinition.configSchema,
          { ...f.config, model: 'extra' },
          'config',
        ),
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('agent-kernel returns validated proposals, charges reported model calls and strips the accounting field', async () => {
  const f = await fixture();
  try {
    const agent = await createAgentKernel(f.config, f as never);
    const output = object(
      await agent.execute(request(f) as never, contextFor(f) as never),
    );
    assert.deepEqual(output, {
      edits: [{ path: 'kernels/vector_add.py', content: 'optimized = True\n' }],
      reason: 'rewrote kernel',
    });
    assert.deepEqual(f.charges, [2]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('agent-kernel rejects a bridge that omits or exceeds the model-call accounting', async () => {
  for (const mode of ['missing-calls', 'over-budget']) {
    const f = await fixture(mode);
    try {
      const agent = await createAgentKernel(f.config, f as never);
      await assert.rejects(
        agent.execute(request(f) as never, contextFor(f) as never),
        mode === 'missing-calls'
          ? /must report modelCalls/
          : /exceeding the 24-call budget/,
      );
      assert.deepEqual(f.charges, []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('agent-kernel maps bridge exit codes, malformed output and schema violations to explicit failures', async () => {
  for (const [mode, pattern, charges] of [
    ['exit', /exit code 7/, []],
    // A nonzero exit with the bridge's {"error": ...} document on stdout
    // surfaces the bridge's own failure reason in the thrown message.
    ['error-json', /model budget exhausted before a proposal/, []],
    ['garbage', /JSON/, []],
    // The bridge consumed its model calls before emitting the invalid
    // output, so the reported consumption is still charged to the budget.
    ['schema-violation', /Agent edit output/, [2]],
  ] as const) {
    const f = await fixture(mode);
    try {
      const agent = await createAgentKernel(f.config, f as never);
      await assert.rejects(
        agent.execute(request(f) as never, contextFor(f) as never),
        pattern,
      );
      assert.deepEqual(f.charges, charges);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('agent-kernel forwards only named environment variables to the bridge', async () => {
  const f = await fixture();
  const previous = process.env.AGENT_KERNEL_TEST_TOKEN;
  process.env.AGENT_KERNEL_TEST_TOKEN = 'bridge-secret';
  try {
    const agent = await createAgentKernel(
      { ...f.config, env: ['AGENT_KERNEL_TEST_TOKEN'] },
      f as never,
    );
    await agent.execute(request(f) as never, contextFor(f) as never);
    const { readFile } = await import('node:fs/promises');
    const bridgeRequest = JSON.parse(
      await readFile(join(f.root, 'request.json'), 'utf8'),
    );
    assert.equal(bridgeRequest.tokenForwarded, true);
    assert.deepEqual(Object.keys(bridgeRequest.request.files), [
      'kernels/vector_add.py',
    ]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_KERNEL_TEST_TOKEN;
    else process.env.AGENT_KERNEL_TEST_TOKEN = previous;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the real kernel-bridge script reports every failure as stdout JSON, never an empty channel', () => {
  // Regression: the BridgeError handler read `error.message`, a Python-2
  // remnant, so the handler itself crashed and stdout stayed empty — the
  // designed `{"error": ...}` channel was dead for exactly the most common
  // failure class. The bridge must emit JSON on stdout and exit nonzero
  // whether the rejection is a BridgeError (ngo_agent importable) or an
  // import-time failure (bare python3) — the channel contract is the same.
  const script = join(
    import.meta.dirname,
    '../../src/plugins/agent-kernel/scripts/kernel-bridge.py',
  );
  let python: string;
  try {
    execFileSync('python3', ['--version'], { timeout: 15000 });
    python = 'python3';
  } catch {
    return; // no python3 on PATH; the service takes `executable` from config
  }
  const failure = (() => {
    try {
      execFileSync(python, [script], {
        input: '{"files": {"wrapper.py": "x"}, "input": {}}',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      return error as { status?: number; stdout?: Buffer | string };
    }
    return undefined;
  })();
  assert.ok(failure, 'a failed proposal must exit nonzero');
  assert.notEqual(failure.status, 0);
  const response = JSON.parse(String(failure.stdout)) as { error?: string };
  assert.equal(typeof response.error, 'string');
  assert.ok(response.error!.length > 0);
});
