import { RuntimeContext } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { JsonObject } from '../../src/contracts/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import type { PolicyOptions } from '../../src/runtime/policy/index.js';

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
  state_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { count: { type: 'integer' } },
  },
  state: { count: 0 },
  steps: [
    {
      id: 'first',
      type: 'loop',
      maxIterations: 2,
      steps: [
        {
          id: 'advance',
          type: 'state',
          state: { count: '${{ state.count + config.increment }}' },
        },
      ],
    },
    {
      id: 'second',
      type: 'loop',
      maxIterations: 1,
      steps: [
        {
          id: 'advance',
          type: 'state',
          state: { count: '${{ state.count + 10 }}' },
        },
      ],
    },
  ],
  output: '${{ state.count }}',
};
function options(context: Context): PolicyOptions {
  return {
    input: {},
    config: { increment: 1 },
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
test('committed step events and loop boundaries carry stable paths without stage tags', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  const trace: string[] = [];
  let checkpoint: JsonObject = {};
  let release!: () => void;
  const notification = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  context.on('rsi/policy-started', async (event) => {
    assert.equal(event.resumed, false);
    trace.push('start-a');
    await Promise.resolve();
    trace.push('start-b');
  });
  context.on('rsi/policy-step-completed', (event) => {
    assert.ok((checkpoint.journal as JsonObject)[event.stepPath]);
    assert.equal(Object.hasOwn(event, 'stage'), false);
    trace.push(event.stepPath);
    return notification;
  });
  context.on('rsi/policy-boundary-completed', async (event) => {
    const key =
      event.boundary === 'policy-completed'
        ? 'policy-completed'
        : `${event.stepPath}/iteration-${event.iteration}`;
    assert.equal((checkpoint.boundaries as JsonObject)[key], true);
    trace.push(`boundary:${key}`);
    await Promise.resolve();
  });
  context.on('rsi/policy-completed', () => {
    trace.push('completed');
  });
  assert.equal(
    await new Policy(definition).execute({
      ...options(context),
      checkpoint: async (value) => {
        checkpoint = value;
      },
    }),
    12,
  );
  assert.deepEqual(trace, [
    'start-a',
    'start-b',
    'steps/first/iteration-0/advance',
    'boundary:steps/first/iteration-0',
    'steps/first/iteration-1/advance',
    'boundary:steps/first/iteration-1',
    'steps/first',
    'steps/second/iteration-0/advance',
    'boundary:steps/second/iteration-0',
    'steps/second',
    'boundary:policy-completed',
    'completed',
  ]);
});
test('recovery skips committed steps and boundaries while marking execution resumed', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
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
  const policy = new Policy(definition);
  const runOptions = {
    ...options(context),
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
    },
  };
  assert.equal(await policy.execute(runOptions), 12);
  assert.equal(
    await policy.execute({ ...runOptions, restore: checkpoint }),
    12,
  );
  assert.deepEqual(resumed, [false, true]);
  assert.equal(steps, 5);
  assert.equal(boundaries, 4);
});
test('notification errors preserve commits and native synchronous listener truncation', async (t) => {
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
  assert.equal(await new Policy(definition).execute(runOptions), 12);
  assert.equal(unexpected, 0);
  assert.deepEqual(diagnostics, [
    ...Array<string>(5).fill('rsi/policy-step-completed'),
    'rsi/policy-completed',
  ]);
});
test('boundary listener failure preserves durable progress and recovery resumes after that boundary', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  let checkpoint: JsonObject = {};
  let advanced = false;
  const off = context.on('rsi/policy-boundary-completed', async () => {
    throw new Error('boundary listener failed');
  });
  context.on('rsi/policy-boundary-completed', () => {
    advanced = true;
    return undefined;
  });
  const policy = new Policy(definition);
  const runOptions = {
    ...options(context),
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
    },
  };
  await assert.rejects(policy.execute(runOptions), /boundary listener failed/);
  assert.ok(
    (checkpoint.journal as JsonObject)['steps/first/iteration-0/advance'],
  );
  assert.equal(
    (checkpoint.journal as JsonObject)['steps/first/iteration-1/advance'],
    undefined,
  );
  assert.equal(
    (checkpoint.boundaries as JsonObject)['steps/first/iteration-0'],
    true,
  );
  assert.equal(advanced, false);
  off();
  assert.equal(
    await policy.execute({ ...runOptions, restore: checkpoint }),
    12,
  );
});
test('checkpoint failure emits no step event and a durable snapshot can finish on recovery', async (t) => {
  const context = new Context();
  t.after(() => context.fiber.dispose());
  let snapshot: JsonObject = {};
  let stepEvents = 0;
  context.on('rsi/policy-step-completed', () => {
    stepEvents++;
  });
  const policy = new Policy(definition);
  await assert.rejects(
    policy.execute({
      ...options(context),
      checkpoint: async (value) => {
        snapshot = value;
        throw new Error('checkpoint interrupted');
      },
    }),
    /checkpoint interrupted/,
  );
  assert.equal(stepEvents, 0);
  assert.equal(
    await policy.execute({ ...options(context), restore: snapshot }),
    12,
  );
  assert.equal(stepEvents, 4);
});
for (const pause of [
  'rsi/policy-started',
  'rsi/policy-boundary-completed',
  'checkpoint',
] as const) {
  test(`cancellation while awaiting ${pause} prevents further checkpoints and completion`, async (t) => {
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
    if (pause !== 'checkpoint') context.on(pause, wait);
    let checkpoints = 0;
    let completions = 0;
    context.on('rsi/policy-completed', () => {
      completions++;
    });
    const runOptions = options(context);
    const running = new Policy({
      ...definition,
      steps: [],
      output: 0,
    }).execute({
      ...runOptions,
      context: runOptions.context.extend({ signal: controller.signal }),
      checkpoint: async () => {
        checkpoints++;
        if (pause === 'checkpoint') await wait();
      },
    });
    await paused;
    const before = checkpoints;
    controller.abort(new Error('experiment cancelled'));
    release();
    await assert.rejects(running, /experiment cancelled/);
    assert.equal(checkpoints, before);
    assert.equal(completions, 0);
  });
}
