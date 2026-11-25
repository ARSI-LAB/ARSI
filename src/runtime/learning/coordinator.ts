import type {
  PolicyBoundaryCompletedEvent,
  EventPipeline,
} from '../../contracts/runtime/events.js';
import type { PolicyCheckpoints } from '../policy/checkpoint.js';
import type { JsonObject } from '../../contracts/json.js';
import type { LearningKind } from '../../contracts/learning.js';
import type { LearningActivation } from '../manager/activation.js';
import { remember } from './memory.js';
import type { LearningResult } from './records.js';
import { reflect, type ReflectionOptions } from './reflection.js';
import type { CycleOptions } from './runner.js';
import type { MemoryConfig, ReflectionConfig } from './schema.js';

type CoordinatorOptions = Pick<
  CycleOptions,
  'context' | 'directory' | 'getDefinition' | 'callId' | 'invoke'
> & {
  memory?: MemoryConfig;
  reflection?: ReflectionConfig;
  activation: LearningActivation;
  attempt?: string;
  sourceResources: ReflectionOptions['sourceResources'];
  checkpoints: PolicyCheckpoints;
};

/** Dispatch serial Policy hooks against the current activation and their durable attempts. */
export class LearningCoordinator {
  readonly memory: MemoryConfig | undefined;
  readonly reflection: ReflectionConfig | undefined;
  private readonly priorRuns = new Map<string, JsonObject[]>();

  constructor(private readonly options: CoordinatorOptions) {
    this.memory = options.memory;
    this.reflection = options.reflection;
  }

  subscribe(event: EventPipeline): void {
    for (const kind of ['memory', 'reflection'] as const) {
      const config = this[kind];
      if (!config) continue;
      event.on('rsi/policy-boundary-completed', async (boundary) => {
        if (
          boundary.experimentId !== this.options.context.experimentId ||
          boundary.policyScopeId !== 'root'
        )
          return;
        const trigger = config.trigger;
        if (!matchesBoundary(trigger, boundary)) return;
        const path =
          boundary.iteration === undefined
            ? (boundary.stepPath ?? 'steps')
            : `${boundary.stepPath}/iteration-${boundary.iteration}`;
        const key = `${path}/@${boundary.boundary}/${kind}`;
        const count = await this.options.checkpoints.triggerHit(kind, key);
        if (count % trigger.every === 0) await this.execute(kind, key, path);
      });
    }
  }

  async restore(): Promise<void> {
    const { context, activation } = this.options;
    const records = context.facts.scan
      ? context.facts.scan('learning-runs')
      : await context.facts.list('learning-runs');
    for await (const record of records) {
      if (
        record.experimentId !== context.experimentId ||
        record.policyScopeId !== 'root' ||
        typeof record.stepPath !== 'string'
      )
        continue;
      const prior = this.priorRuns.get(record.stepPath) ?? [];
      prior.push(record);
      this.priorRuns.set(record.stepPath, prior);
    }
    await activation.restore();
  }

  async execute(
    kind: LearningKind,
    stepPath: string,
    triggerPath: string,
  ): Promise<LearningResult> {
    const {
      context,
      activation,
      attempt,
      invoke,
      callId,
      directory,
      getDefinition,
      sourceResources,
    } = this.options;
    const common = {
      invocation: {
        policyScopeId: 'root',
        stepPath,
        triggerPath,
        ...(attempt ? { attempt } : {}),
      },
      priorAttempts: this.priorRuns.get(stepPath),
      context,
      directory,
      invoke,
      callId,
      getDefinition,
      bindings: activation.bindings,
      revisionRefs: activation.revisionRefs,
    };
    if (kind === 'reflection' && this.reflection)
      return reflect({
        ...common,
        config: this.reflection,
        sourceResources,
        reflectionRevisionRef: activation.reflectionRevisionRef,
        initialize: (parents, head) => activation.initialize(parents, head),
        save: (changes, revisions, id, head) =>
          activation.saveRevisions(changes, revisions, id, head),
      });
    if (kind !== 'memory' || !this.memory)
      throw new Error('Unknown learning module ' + kind);
    return remember({
      ...common,
      config: this.memory,
      active: () => activation.memory,
      saveMemory: (memory, id) => activation.saveMemory(memory, id),
    });
  }
}

function matchesBoundary(
  trigger: MemoryConfig['trigger'],
  event: PolicyBoundaryCompletedEvent,
): boolean {
  switch (trigger.on) {
    case 'after-step':
      return (
        event.boundary === 'step-completed' && event.stepId === trigger.step
      );
    case 'loop-end':
      return event.boundary === 'loop-completed';
    case 'experiment-end':
      return event.boundary === 'policy-completed';
    case 'loop-iteration':
      return event.hasTopLevelLoop
        ? event.boundary === 'iteration-completed'
        : event.boundary === 'policy-completed';
  }
}
