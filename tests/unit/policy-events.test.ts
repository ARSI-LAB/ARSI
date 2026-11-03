import { RuntimeContext } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { JsonObject } from '../../src/contracts/index.js';
import { compilePolicy } from '../../src/runtime/compiler/index.js';
import {
  executePolicy,
  type PolicyOptions,
} from '../../src/runtime/policy/index.js';

const definition = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.events',
  input_schema: { type: 'object', additionalProperties: false },
  output_schema: { type: 'integer' },
  config_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { increment: { type: 'integer' } },
  },
  init: { steps: [{ id: 'initialize', state: { count: 0 } }] },
  loop: {
    maxIterations: 2,
    steps: [
      {
        id: 'advance',
        state: { count: '${{ state.count + config.increment }}' },
      },
    ],
  },
  finish: {
    steps: [{ id: 'finish', state: { count: '${{ state.count + 10 }}' } }],
  },
  output: '${{ state.count }}',
};

function options(context: Context): PolicyOptions {
  return {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
      event: {
        emit: context.emit.bind(context),
        parallel: context.parallel.bind(context),
        serial: context.serial.bind(context),
        bail: context.bail.bind(context),
        waterfall: context.waterfall.bind(context),
        on() {
          throw new Error('Unexpected subscription');
        },
      },
    }),
    invoke: async () => null,
    checkpoint: async () => {},
    boundary: async () => {},
    events: {
      info: {
        experimentId: 'exp-events',
        policyScopeId: 'root',
        checkpointRef: 'exp-events',
      },
      diagnose: () => {},
    },
  };
}

test('Policy publishes committed progress in order and applies boundary patches before advancing', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  const policy = compilePolicy(definition);
  const trace: string[] = [];
  let checkpoint: JsonObject = {};
  let finishNotification: (() => void) | undefined;
  const notification = new Promise<void>((resolve) => {
    finishNotification = resolve;
  });
  context.on('rsi/policy-started', async (event) => {
    assert.deepEqual(event, {
      experimentId: 'exp-events',
      policyScopeId: 'root',
      checkpointRef: 'exp-events',
      policyId: 'policy.events',
      resumed: false,
    });
    trace.push('start-a');
    await Promise.resolve();
    trace.push('start-b');
  });
  context.on('rsi/policy-step-completed', (event) => {
    assert.ok((checkpoint.journal as JsonObject)[event.stepPath]);
    trace.push(`${event.stage}:${event.stepPath}`);
    return notification;
  });
  context.on('rsi/policy-boundary-completed', async (event) => {
    assert.ok(
      Object.hasOwn(
        checkpoint.boundaries as JsonObject,
        String(event.iteration),
      ),
    );
    trace.push(`boundary:${event.iteration}`);
    await Promise.resolve();
  });
  context.on('rsi/policy-completed', () => {
    trace.push('completed');
  });
  assert.equal(
    await executePolicy(
      policy,
      {},
      { increment: 1 },
      {
        ...options(context),
        checkpoint: async (value) => {
          checkpoint = value;
        },
        boundary: async (iteration) => {
          trace.push(`callback:${iteration}`);
          return { increment: 2 };
        },
      },
    ),
    13,
  );
  assert.deepEqual(trace, [
    'start-a',
    'start-b',
    'init:init/initialize',
    'loop:loop/0/advance',
    'callback:0',
    'boundary:0',
    'loop:loop/1/advance',
    'callback:1',
    'boundary:1',
    'finish:finish/finish',
    'completed',
  ]);
  finishNotification!();
});

test('Policy recovery skips committed steps and boundaries while marking the execution resumed', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  const policy = compilePolicy(definition);
  let checkpoint: JsonObject | undefined;
  let steps = 0;
  let boundaries = 0;
  const resumed: boolean[] = [];
  context.on('rsi/policy-started', (event) => {
    resumed.push(event.resumed);
    return undefined;
  });
  context.on('rsi/policy-step-completed', () => {
    steps++;
  });
  context.on('rsi/policy-boundary-completed', () => {
    boundaries++;
    return undefined;
  });
  const runOptions = {
    ...options(context),
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
    },
    boundary: async () => ({ increment: 2 }),
  };
  assert.equal(
    await executePolicy(policy, {}, { increment: 1 }, runOptions),
    13,
  );
  assert.equal(
    await executePolicy(
      policy,
      {},
      { increment: 1 },
      {
        ...runOptions,
        restore: checkpoint,
      },
    ),
    13,
  );
  assert.deepEqual(resumed, [false, true]);
  assert.equal(steps, 4);
  assert.equal(boundaries, 2);
});

test('Policy notification errors preserve committed progress and native synchronous truncation', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  const diagnostics: string[] = [];
  let unexpected = 0;
  context.on('rsi/policy-step-completed', () => {
    throw new Error('notification failed');
  });
  context.on('rsi/policy-step-completed', () => {
    unexpected++;
  });
  context.on('rsi/policy-completed', () => {
    throw new Error('completion failed');
  });
  const runOptions = options(context);
  runOptions.events!.diagnose = (name, error) => {
    assert.ok(error instanceof Error);
    diagnostics.push(name);
  };
  assert.equal(
    await executePolicy(
      compilePolicy(definition),
      {},
      { increment: 1 },
      runOptions,
    ),
    12,
  );
  assert.equal(unexpected, 0);
  assert.deepEqual(diagnostics, [
    ...Array<string>(4).fill('rsi/policy-step-completed'),
    'rsi/policy-completed',
  ]);
});

test('Policy serial failures block progress without undoing persisted steps or boundaries', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  let checkpoint: JsonObject = {};
  let advanced = false;
  context.on('rsi/policy-boundary-completed', async () => {
    throw new Error('boundary listener failed');
  });
  context.on('rsi/policy-boundary-completed', () => {
    advanced = true;
    return undefined;
  });
  await assert.rejects(
    executePolicy(
      compilePolicy(definition),
      {},
      { increment: 1 },
      {
        ...options(context),
        checkpoint: async (value) => {
          checkpoint = value;
        },
      },
    ),
    /boundary listener failed/,
  );
  assert.ok((checkpoint.journal as JsonObject)['loop/0/advance']);
  assert.equal((checkpoint.journal as JsonObject)['loop/1/advance'], undefined);
  assert.ok(Object.hasOwn(checkpoint.boundaries as JsonObject, '0'));
  assert.equal(advanced, false);
});

test('Policy completion boundary applies configuration patches and does not replay on recovery', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  const { loop: _loop, finish: _finish, ...oneShot } = definition;
  const policy = compilePolicy({
    ...oneShot,
    output: '${{ config.increment }}',
  });
  let checkpoint: JsonObject | undefined;
  let boundaries = 0;
  context.on('rsi/policy-boundary-completed', (event) => {
    assert.equal(event.boundary, 'policy-completed');
    assert.equal(event.iteration, undefined);
    boundaries++;
    return undefined;
  });
  const runOptions = {
    ...options(context),
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
    },
    boundary: async () => ({ increment: 7 }),
  };
  assert.equal(
    await executePolicy(policy, {}, { increment: 1 }, runOptions),
    7,
  );
  assert.equal(
    await executePolicy(
      policy,
      {},
      { increment: 1 },
      {
        ...runOptions,
        restore: checkpoint,
      },
    ),
    7,
  );
  assert.equal(boundaries, 1);
});

for (const pause of [
  'rsi/policy-started',
  'rsi/policy-boundary-completed',
  'boundary-callback',
] as const) {
  test(`Policy cancellation while awaiting ${pause} blocks late progress even with empty steps`, async (t) => {
    const context = new Context();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(async () => {
      release();
      await context.fiber.dispose();
    });
    const wait = async (): Promise<undefined> => {
      entered();
      await gate;
      return undefined;
    };
    if (pause !== 'boundary-callback') context.on(pause, wait);
    let checkpoints = 0;
    let boundaries = 0;
    let completions = 0;
    context.on('rsi/policy-completed', () => {
      completions++;
    });
    const policy = compilePolicy({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.empty-events',
      input_schema: { type: 'object' },
      output_schema: { type: 'integer' },
      init: { steps: [] },
      output: 0,
    });
    const running = executePolicy(
      policy,
      {},
      {},
      {
        ...options(context),
        context: options(context).context.extend({ signal: controller.signal }),
        checkpoint: async () => {
          checkpoints++;
        },
        boundary: async () => {
          boundaries++;
          if (pause === 'boundary-callback') return wait();
        },
      },
    );
    await paused;
    const checkpointsAtCancellation = checkpoints;
    controller.abort(new Error('experiment cancelled'));
    release();
    await assert.rejects(running, /experiment cancelled/);
    assert.equal(checkpoints, checkpointsAtCancellation);
    assert.equal(boundaries, pause === 'rsi/policy-started' ? 0 : 1);
    assert.equal(completions, 0);
  });
}
