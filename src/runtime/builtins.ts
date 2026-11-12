import { fileURLToPath } from 'node:url';
import { Registry } from './registry/index.js';
import { Policy } from './policy/index.js';
import { agentbundleDefinition } from '../plugins/application-agentbundle/index.js';
import { inferenceDefinition } from '../plugins/application-inference/index.js';
import { piDefinition } from '../plugins/agent-pi/index.js';
import { claudeCodeDefinition } from '../plugins/agent-claudecode/index.js';
import { dshDefinition } from '../plugins/agent-dsh/index.js';
import { codexDefinition } from '../plugins/agent-codex/index.js';
import { proposerDefinition } from '../plugins/proposer-agent/index.js';
import { operatorProposerDefinition } from '../plugins/proposer-operator/index.js';
import { operatorSummarizerDefinition } from '../plugins/summarizer-operator/index.js';
import { gridProposerDefinition } from '../plugins/proposer-grid/index.js';
import { optunaProposerDefinition } from '../plugins/proposer-optuna/index.js';
import { paretoEvolutionProposerDefinition } from '../plugins/proposer-pareto-evolution/index.js';
import { memoryDefinition } from '../plugins/memory-agent/index.js';
import { reflectionDefinition } from '../plugins/reflection-agent/index.js';
import { agentbenchDefinition } from '../plugins/evaluator-agentbench/index.js';
import { inferencebenchDefinition } from '../plugins/evaluator-inferencebench/index.js';
import { inferenceSelectorDefinition } from '../plugins/selector-inference/index.js';
import { metricSelectorDefinition } from '../plugins/selector-metrics/index.js';
import { artifactSelectorDefinition } from '../plugins/selector-artifacts/index.js';
import { kernelApplicationDefinition } from '../plugins/application-kernel/index.js';
import { operatorbenchDefinition } from '../plugins/evaluator-operatorbench/index.js';
import type { OperationDefinition } from '../contracts/index.js';
/** Startup code is the sole built-in registration list. Registration never runs an experiment. */
export async function registerBuiltins(registry: Registry): Promise<void> {
  const definitions: OperationDefinition[] = [
    agentbundleDefinition,
    inferenceDefinition,
    piDefinition,
    codexDefinition,
    claudeCodeDefinition,
    dshDefinition,
    proposerDefinition,
    operatorProposerDefinition,
    operatorSummarizerDefinition,
    gridProposerDefinition,
    optunaProposerDefinition,
    paretoEvolutionProposerDefinition,
    memoryDefinition,
    reflectionDefinition,
    agentbenchDefinition,
    inferencebenchDefinition,
    inferenceSelectorDefinition,
    metricSelectorDefinition,
    artifactSelectorDefinition,
    kernelApplicationDefinition,
    operatorbenchDefinition,
  ];
  for (const definition of definitions) registry.registerOperation(definition);
  for (const path of [
    'harness2/policy.yaml',
    'wikiskill/policy.yaml',
    'operator-search/policy.yaml',
    'parameter/grid/policy.yaml',
    'parameter/optuna/policy.yaml',
    'parameter/agent/policy.yaml',
    'gepa/policy.yaml',
  ]) {
    const file = fileURLToPath(new URL(`../policies/${path}`, import.meta.url));
    const policy = await Policy.load(file, registry);
    registry.registerPolicy(String(policy.id), file);
  }
}
