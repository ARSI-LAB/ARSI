import { fileURLToPath } from 'node:url';
import { Registry } from './registry/index.js';
import { Policy } from './policy/index.js';
import {
  agentbundleDefinition,
  agentbundleEvents,
} from '../plugins/application-agentbundle/index.js';
import {
  inferenceDefinition,
  inferenceEvents,
} from '../plugins/application-inference/index.js';
import { piDefinition, piEvents } from '../plugins/agent-pi/index.js';
import {
  claudeCodeDefinition,
  claudeCodeEvents,
} from '../plugins/agent-claudecode/index.js';
import {
  openCodeDefinition,
  openCodeEvents,
} from '../plugins/agent-opencode/index.js';
import { dshDefinition, dshEvents } from '../plugins/agent-dsh/index.js';
import { codexDefinition, codexEvents } from '../plugins/agent-codex/index.js';
import {
  proposerDefinition,
  proposerEvents,
} from '../plugins/proposer-agent/index.js';
import {
  operatorProposerDefinition,
  operatorProposerEvents,
} from '../plugins/proposer-operator/index.js';
import { operatorSummarizerDefinition } from '../plugins/summarizer-operator/index.js';
import {
  gridProposerDefinition,
  gridProposerEvents,
} from '../plugins/proposer-grid/index.js';
import {
  optunaProposerDefinition,
  optunaProposerEvents,
} from '../plugins/proposer-optuna/index.js';
import {
  paretoEvolutionProposerDefinition,
  paretoEvolutionProposerEvents,
} from '../plugins/proposer-pareto-evolution/index.js';
import {
  memoryDefinition,
  memoryEvents,
} from '../plugins/memory-agent/index.js';
import {
  reflectionDefinition,
  reflectionEvents,
} from '../plugins/reflection-agent/index.js';
import {
  agentbenchDefinition,
  agentbenchEvents,
} from '../plugins/evaluator-agentbench/index.js';
import { gymDefinition, gymEvents } from '../plugins/evaluator-gym/index.js';
import {
  inferencebenchDefinition,
  inferencebenchEvents,
} from '../plugins/evaluator-inferencebench/index.js';
import {
  inferenceSelectorDefinition,
  inferenceSelectorEvents,
} from '../plugins/selector-inference/index.js';
import {
  metricSelectorDefinition,
  metricSelectorEvents,
} from '../plugins/selector-metrics/index.js';
import {
  artifactSelectorDefinition,
  artifactSelectorEvents,
} from '../plugins/selector-artifacts/index.js';
import {
  kernelApplicationDefinition,
  kernelApplicationEvents,
} from '../plugins/application-kernel/index.js';
import {
  operatorbenchDefinition,
  operatorbenchEvents,
} from '../plugins/evaluator-operatorbench/index.js';
/** Startup code is the sole built-in registration list. Registration never runs an experiment. */
export async function registerBuiltins(registry: Registry): Promise<void> {
  registry.registerOperation(agentbundleDefinition, agentbundleEvents);
  registry.registerOperation(inferenceDefinition, inferenceEvents);
  registry.registerOperation(piDefinition, piEvents);
  registry.registerOperation(codexDefinition, codexEvents);
  registry.registerOperation(claudeCodeDefinition, claudeCodeEvents);
  registry.registerOperation(dshDefinition, dshEvents);
  registry.registerOperation(openCodeDefinition, openCodeEvents);
  registry.registerOperation(proposerDefinition, proposerEvents);
  registry.registerOperation(
    operatorProposerDefinition,
    operatorProposerEvents,
  );
  registry.registerOperation(operatorSummarizerDefinition);
  registry.registerOperation(gridProposerDefinition, gridProposerEvents);
  registry.registerOperation(optunaProposerDefinition, optunaProposerEvents);
  registry.registerOperation(
    paretoEvolutionProposerDefinition,
    paretoEvolutionProposerEvents,
  );
  registry.registerOperation(memoryDefinition, memoryEvents);
  registry.registerOperation(reflectionDefinition, reflectionEvents);
  registry.registerOperation(gymDefinition, gymEvents);
  registry.registerOperation(
    inferenceSelectorDefinition,
    inferenceSelectorEvents,
  );
  registry.registerOperation(metricSelectorDefinition, metricSelectorEvents);
  registry.registerOperation(
    artifactSelectorDefinition,
    artifactSelectorEvents,
  );
  registry.registerOperation(
    kernelApplicationDefinition,
    kernelApplicationEvents,
  );
  registry.registerOperation(agentbenchDefinition, agentbenchEvents);
  registry.registerOperation(inferencebenchDefinition, inferencebenchEvents);
  registry.registerOperation(operatorbenchDefinition, operatorbenchEvents);
  for (const path of [
    'harness2/policy.yaml',
    'wikiskill/policy.yaml',
    'gym-rsi/policy.yaml',
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
