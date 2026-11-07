import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context, Events } from '@deepseek-ai/cordis';
import type { SdkEvaluatorConfig } from '../../src/plugins/shared/evaluator-adapter/configuration.js';
import type {
  AgentInput,
  AgentOutput,
  AgentbenchInput,
  AgentbenchOutput,
  ApplicationInput,
  ApplicationOutput,
  RuntimeContext,
  CallDecision,
  EventPublisher,
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  InferencebenchInput,
  InferencebenchOutput,
  JsonObject,
  JsonValue,
  MemoryInput,
  MemoryOutput,
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
  OperatorAttemptOutcome,
  OperatorProposerInput,
  OperatorProposerOutput,
  OperatorbenchInput,
  OperatorbenchOutput,
  EventPipeline,
  ProposerInput,
  ProposerOutput,
  ReflectionInput,
  ReflectionOutput,
} from '../../src/contracts/index.js';
import * as contracts from '../../src/contracts/plugin-types/index.js';
import { validate } from '../../src/shared/schema.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { agentbundleDefinition } from '../../src/plugins/application-agentbundle/index.js';
import { inferenceDefinition } from '../../src/plugins/application-inference/index.js';
import { agentbenchDefinition } from '../../src/plugins/evaluator-agentbench/index.js';
import { inferencebenchDefinition } from '../../src/plugins/evaluator-inferencebench/index.js';
import { proposerDefinition } from '../../src/plugins/proposer-agent/index.js';
import { memoryDefinition } from '../../src/plugins/memory-agent/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { artifactSelectorDefinition } from '../../src/plugins/selector-artifacts/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';
import { gridProposerDefinition } from '../../src/plugins/proposer-grid/index.js';
import { kernelApplicationDefinition } from '../../src/plugins/application-kernel/index.js';
import { operatorbenchDefinition } from '../../src/plugins/evaluator-operatorbench/index.js';
import { operatorProposerDefinition } from '../../src/plugins/proposer-operator/index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Check<T extends true> = T;
type IO<D extends OperationDefinition> =
  Awaited<ReturnType<D['create']>> extends {
    execute(input: infer I, context: never): Promise<infer O>;
  }
    ? [I, O]
    : never;
type Config<D extends OperationDefinition> = Parameters<D['create']>[0];
type HasOpenConfig<D extends OperationDefinition> =
  D extends OperationDefinition
    ? string extends keyof Config<D>
      ? true
      : false
    : never;

export type ConcreteConfigChecks = [
  Check<
    Equal<
      Config<typeof piDefinition>['thinkingLevel'],
      'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined
    >
  >,
  Check<
    Equal<
      Config<typeof metricSelectorDefinition>['direction'],
      'maximize' | 'minimize' | undefined
    >
  >,
  Check<
    Equal<
      Config<typeof agentbundleDefinition>['target'],
      { schema: string | JsonObject }
    >
  >,
  Check<
    Equal<
      Extract<
        Config<typeof inferenceDefinition>,
        { start: unknown }
      >['endpoint'],
      { basePath?: string; model: string }
    >
  >,
  Check<
    Equal<
      Extract<
        Config<typeof inferenceDefinition>,
        { remote: unknown }
      >['endpoint']['origin'],
      string
    >
  >,
  Check<
    Equal<
      Config<typeof gridProposerDefinition>['searchSpace'][number],
      { name: string; values: JsonValue[] }
    >
  >,
  Check<
    Equal<
      Config<typeof agentbenchDefinition>['benchmark'],
      SdkEvaluatorConfig['benchmark'] & JsonValue
    >
  >,
  Check<
    Equal<
      Config<typeof inferencebenchDefinition>['benchmark'],
      SdkEvaluatorConfig['benchmark'] & JsonValue
    >
  >,
  Check<Equal<Config<typeof proposerDefinition>['prompt'], string>>,
  Check<Equal<Config<typeof memoryDefinition>['prompt'], string>>,
  Check<Equal<Config<typeof reflectionDefinition>['prompt'], string>>,
  Check<Equal<Config<typeof artifactSelectorDefinition>['prompt'], string>>,
  Check<
    Equal<
      Config<typeof operatorbenchDefinition>['benchmark'],
      SdkEvaluatorConfig['benchmark'] & JsonValue
    >
  >,
  Check<
    Equal<
      Config<typeof kernelApplicationDefinition>['target'],
      { schema: string | JsonObject }
    >
  >,
  Check<
    Equal<
      HasOpenConfig<
        | typeof piDefinition
        | typeof agentbundleDefinition
        | typeof inferenceDefinition
        | typeof agentbenchDefinition
        | typeof inferencebenchDefinition
        | typeof proposerDefinition
        | typeof memoryDefinition
        | typeof reflectionDefinition
        | typeof artifactSelectorDefinition
        | typeof metricSelectorDefinition
        | typeof gridProposerDefinition
        | typeof kernelApplicationDefinition
        | typeof operatorbenchDefinition
        | typeof operatorProposerDefinition
      >,
      false
    >
  >,
  Check<Equal<{} extends Config<typeof piDefinition> ? true : false, true>>,
  Check<
    Equal<{} extends Config<typeof proposerDefinition> ? true : false, false>
  >,
  Check<
    Equal<{} extends Config<typeof agentbenchDefinition> ? true : false, false>
  >,
  Check<
    Equal<
      { thinkingLevel: 'invalid' } extends Config<typeof piDefinition>
        ? true
        : false,
      false
    >
  >,
  Check<
    Equal<
      { constraints: [{ metric: 'latency' }] } extends Config<
        typeof metricSelectorDefinition
      >
        ? true
        : false,
      false
    >
  >,
];

export type OperatorProposerChecks = [
  Check<
    Equal<
      Extract<
        OperatorProposerInput,
        { action: 'propose'; phase: 'static' }
      >['baselineMeasurementRef'],
      string
    >
  >,
  Check<
    Equal<
      Extract<
        OperatorProposerInput,
        { action: 'propose'; phase: 'static' }
      >['analysisRef'],
      string | null
    >
  >,
  Check<
    Equal<
      Extract<OperatorProposerInput, { action: 'repair' }>['analysisRef'],
      string
    >
  >,
  Check<
    Equal<
      Extract<
        OperatorProposerOutput,
        { action: 'propose'; status: 'created' }
      >['diffRef'],
      string
    >
  >,
  Check<
    Equal<
      Extract<
        OperatorProposerOutput,
        { action: 'repair'; status: 'no-change' }
      >['reasonCode'],
      'no-supported-change'
    >
  >,
  Check<
    Equal<
      OperatorAttemptOutcome,
      | 'adopted'
      | 'verified-no-gain'
      | 'verification-failed'
      | 'no-change'
      | 'proposal-failed'
    >
  >,
];

declare const pipeline: EventPipeline;
type CallListener = Parameters<typeof pipeline.on<'rsi/before-call'>>[1];
type PreparationListener = Parameters<
  typeof pipeline.on<'rsi/before-experiment'>
>[1];
export type PublicEventChecks = [
  Check<
    Equal<
      EventPublisher,
      Pick<Context, 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'>
    >
  >,
  Check<
    Equal<
      Parameters<CallListener>,
      [...Parameters<Events['rsi/before-call']>, RuntimeContext]
    >
  >,
  Check<Equal<ReturnType<CallListener>, Promise<CallDecision>>>,
  Check<Equal<ReturnType<PreparationListener>, undefined | Promise<undefined>>>,
  Check<
    Equal<'listeners' extends keyof OperationDefinition ? true : false, false>
  >,
  Check<Equal<RuntimeContext['event'], EventPipeline>>,
  Check<
    Equal<
      (() => Promise<{ kind: 'invalid' }>) extends CallListener ? true : false,
      false
    >
  >,
  Check<Equal<(() => true) extends PreparationListener ? true : false, false>>,
];
// These assertions run through the repository's typecheck without diagnostic suppression.
export type ConcreteOperationChecks = [
  Check<Equal<IO<typeof piDefinition>, [AgentInput, AgentOutput]>>,
  Check<
    Equal<
      IO<typeof kernelApplicationDefinition>,
      [ApplicationInput, ApplicationOutput]
    >
  >,
  Check<
    Equal<
      IO<typeof operatorbenchDefinition>,
      [OperatorbenchInput, OperatorbenchOutput]
    >
  >,
  Check<
    Equal<
      IO<typeof operatorProposerDefinition>,
      [OperatorProposerInput, OperatorProposerOutput]
    >
  >,
  Check<Equal<MetricSelectorOutput['candidateValue'], number | null>>,
  Check<
    Equal<
      IO<typeof agentbundleDefinition>,
      [ApplicationInput, ApplicationOutput]
    >
  >,
  Check<
    Equal<IO<typeof inferenceDefinition>, [ApplicationInput, ApplicationOutput]>
  >,
  Check<
    Equal<IO<typeof agentbenchDefinition>, [AgentbenchInput, AgentbenchOutput]>
  >,
  Check<
    Equal<
      IO<typeof inferencebenchDefinition>,
      [InferencebenchInput, InferencebenchOutput]
    >
  >,
  Check<Equal<IO<typeof proposerDefinition>, [ProposerInput, ProposerOutput]>>,
  Check<Equal<IO<typeof memoryDefinition>, [MemoryInput, MemoryOutput]>>,
  Check<
    Equal<IO<typeof reflectionDefinition>, [ReflectionInput, ReflectionOutput]>
  >,
  Check<
    Equal<
      IO<typeof artifactSelectorDefinition>,
      [ArtifactSelectorInput, ArtifactSelectorOutput]
    >
  >,
  Check<
    Equal<
      IO<typeof metricSelectorDefinition>,
      [MetricSelectorInput, MetricSelectorOutput]
    >
  >,
  Check<
    Equal<{ action: 'commit' } extends ApplicationInput ? true : false, false>
  >,
  Check<
    Equal<
      { candidateRef: string } extends AgentbenchInput ? true : false,
      false
    >
  >,
  Check<
    Equal<'taskIds' extends keyof InferencebenchInput ? true : false, false>
  >,
  Check<
    Equal<
      {
        status: 'created';
        candidateRef: string;
        diffRef: null;
        rationale: string;
      } extends ProposerOutput
        ? true
        : false,
      false
    >
  >,
  Check<
    Equal<
      {
        status: 'updated';
        memoryRef: null;
        changeRef: string;
        reason: string;
      } extends MemoryOutput
        ? true
        : false,
      false
    >
  >,
  Check<
    Equal<
      {
        status: 'proposed';
        proposal: null;
        reason: string;
      } extends ReflectionOutput
        ? true
        : false,
      false
    >
  >,
];

test('operator plugin definitions use their public contract objects', () => {
  for (const [definition, contract] of [
    [kernelApplicationDefinition, contracts.applicationContract],
    [operatorbenchDefinition, contracts.operatorbenchContract],
    [operatorProposerDefinition, contracts.operatorProposerContract],
  ] as const) {
    assert.equal(definition.contract, contract, definition.id);
  }
});

test('typed inputs and outputs satisfy public contract Schemas', () => {
  const cases = [
    {
      contract: contracts.agentContract,
      input: {
        goal: 'Improve',
        prompt: 'Return JSON',
        outputSchema: {},
      } satisfies AgentInput,
      output: { answer: 1 } satisfies AgentOutput,
    },
    {
      contract: contracts.applicationContract,
      input: { action: 'initialize' } satisfies ApplicationInput,
      output: {
        action: 'initialize',
        initialCandidateRef: 'c',
        target: {},
        capabilities: [],
      } satisfies ApplicationOutput,
    },
    {
      contract: contracts.agentbenchContract,
      input: { candidateRef: 'c', taskIds: ['task'] } satisfies AgentbenchInput,
      output: { measurementRef: 'm' } satisfies AgentbenchOutput,
    },
    {
      contract: contracts.inferencebenchContract,
      input: { candidateRef: 'c' } satisfies InferencebenchInput,
      output: { measurementRef: 'm' } satisfies InferencebenchOutput,
    },
    {
      contract: contracts.operatorProposerContract,
      input: {
        action: 'propose',
        phase: 'static',
        entryCandidateRef: 'c',
        baselineMeasurementRef: 'baseline',
        attempt: 1,
        goal: 'Improve',
        analysisRef: null,
        historyRef: null,
      } satisfies OperatorProposerInput,
      output: {
        action: 'propose',
        status: 'created',
        candidateRef: 'next',
        diffRef: 'diff',
        rationale: 'One change',
        analysisRef: 'analysis',
        reasonCode: 'created',
      } satisfies OperatorProposerOutput,
    },
    {
      contract: contracts.operatorProposerContract,
      input: {
        action: 'repair',
        phase: 'static',
        failedCandidateRef: 'c',
        measurementRef: 'm',
        analysisRef: 'analysis',
        historyRef: null,
        attempt: 1,
        repairIndex: 1,
        goal: 'Repair',
      } satisfies OperatorProposerInput,
      output: {
        action: 'repair',
        status: 'no-change',
        candidateRef: 'c',
        diffRef: null,
        rationale: 'No supported repair',
        analysisRef: 'analysis',
        reasonCode: 'no-supported-change',
      } satisfies OperatorProposerOutput,
    },
    {
      contract: contracts.operatorProposerContract,
      input: {
        action: 'summarize',
        phase: 'static',
        entryCandidateRef: 'c',
        analysisRef: 'analysis',
        historyRef: null,
        attempt: 1,
        candidateRefs: ['c'],
        measurementRefs: [],
        decisionRef: null,
        outcome: 'no-change',
      } satisfies OperatorProposerInput,
      output: {
        action: 'summarize',
        historyRef: 'history',
        summaryRef: 'summary',
      } satisfies OperatorProposerOutput,
    },
    {
      contract: contracts.operatorbenchContract,
      input: {
        candidateRef: 'c',
        action: 'evaluate',
        caseIds: ['fixed'],
      } satisfies OperatorbenchInput,
      output: {
        action: 'evaluate',
        measurementRef: 'm',
      } satisfies OperatorbenchOutput,
    },
    {
      contract: contracts.proposerContract,
      input: {
        parent: 'c',
        goal: 'Improve',
        evidenceRefs: [],
      } satisfies ProposerInput,
      output: {
        status: 'no-change',
        candidateRef: 'c',
        diffRef: null,
        rationale: '',
      } satisfies ProposerOutput,
    },
    {
      contract: contracts.memoryContract,
      input: {
        memoryRef: null,
        goal: 'Learn',
        evidenceRefs: [],
      } satisfies MemoryInput,
      output: {
        status: 'no-change',
        memoryRef: null,
        changeRef: null,
        reason: '',
      } satisfies MemoryOutput,
    },
    {
      contract: contracts.reflectionContract,
      input: {
        parentRevisionRefs: { proposer: 'r' },
        resourceRef: 'a',
        goal: 'Improve',
        evidenceRefs: [],
        editConstraints: {},
      } satisfies ReflectionInput,
      output: {
        status: 'no-change',
        proposal: null,
        reason: '',
      } satisfies ReflectionOutput,
    },
    {
      contract: contracts.artifactSelectorContract,
      input: {
        candidates: [{ candidateRef: 'c', measurementRef: 'm' }],
        rubric: 'quality',
      } satisfies ArtifactSelectorInput,
      output: {
        candidateRef: 'c',
        measurementRef: 'm',
        decisionRef: 'd',
      } satisfies ArtifactSelectorOutput,
    },
    {
      contract: contracts.metricSelectorContract,
      input: {
        incumbentMeasurementRef: 'before',
        candidateMeasurementRef: 'after',
      } satisfies MetricSelectorInput,
      output: {
        accepted: true,
        candidateFeasible: true,
        selectedCandidateRef: 'c',
        reason: '',
        decisionRef: 'd',
        measurementRef: 'm',
        metric: 'quality',
        incumbentValue: 0,
        candidateValue: 1,
        selectedValue: 1,
      } satisfies MetricSelectorOutput,
    },
    {
      contract: contracts.metricSelectorContract,
      input: {
        incumbentMeasurementRef: 'before',
        candidateMeasurementRef: 'invalid',
      } satisfies MetricSelectorInput,
      output: {
        accepted: false,
        candidateFeasible: false,
        selectedCandidateRef: 'incumbent',
        reason: 'Candidate is ineligible',
        decisionRef: 'd',
        measurementRef: 'before',
        metric: 'latencyMs',
        incumbentValue: 10,
        candidateValue: null,
        selectedValue: 10,
      } satisfies MetricSelectorOutput,
    },
  ];
  for (const { contract, input, output } of cases) {
    assert.doesNotThrow(() =>
      validate(contract.input_schema, input, contract.id),
    );
    assert.doesNotThrow(() =>
      validate(contract.output_schema, output, contract.id),
    );
  }
});

test('contract Schemas retain required fields, discriminated branches and collection constraints', () => {
  const cases = [
    {
      schema: contracts.agentContract.input_schema,
      value: { goal: 'Improve', prompt: 'Return JSON' },
    },
    {
      schema: contracts.applicationContract.input_schema,
      value: { action: 'commit', parentCandidateRef: 'c' },
    },
    {
      schema: contracts.agentbenchContract.input_schema,
      value: { candidateRef: 'c', taskIds: ['task', 'task'] },
    },
    {
      schema: contracts.inferencebenchContract.input_schema,
      value: { candidateRef: '' },
    },
    {
      schema: contracts.operatorbenchContract.input_schema,
      value: { action: 'evaluate', candidateRef: 'c', caseIds: [] },
    },
    {
      schema: contracts.operatorbenchContract.input_schema,
      value: {
        action: 'evaluate',
        candidateRef: 'c',
        caseIds: ['fixed', 'fixed'],
      },
    },
    {
      schema: contracts.memoryContract.output_schema,
      value: { status: 'updated', memoryRef: null, changeRef: 'a', reason: '' },
    },
    {
      schema: contracts.proposerContract.output_schema,
      value: {
        status: 'created',
        candidateRef: 'c',
        diffRef: null,
        rationale: '',
      },
    },
    {
      schema: contracts.reflectionContract.output_schema,
      value: { status: 'proposed', proposal: null, reason: '' },
    },
    {
      schema: contracts.artifactSelectorContract.input_schema,
      value: { candidates: [], rubric: 'quality' },
    },
    {
      schema: contracts.metricSelectorContract.input_schema,
      value: {
        incumbentMeasurementRef: 'm',
        candidateMeasurementRef: 'n',
        extra: true,
      },
    },
  ];
  for (const { schema, value } of cases)
    assert.throws(() => validate(schema, value));
});

test('Memory comparison keeps the frozen public contract Schema', () => {
  assert.equal(Object.isFrozen(contracts.memoryContract), true);
  assert.equal(Object.isFrozen(contracts.memoryComparisonSchema), true);
  assert.equal(
    Object.isFrozen(contracts.memoryComparisonSchema.properties),
    true,
  );
});
