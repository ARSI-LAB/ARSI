import { fileURLToPath } from 'node:url';
import { Registry } from './registry/index.js';
import { readPolicy } from './compiler/index.js';
import { agentbundleDefinition } from '../plugins/application-agentbundle/index.js';
import { inferenceDefinition } from '../plugins/application-inference/index.js';
import { piDefinition } from '../plugins/agent-pi/index.js';
import { codexDefinition } from '../plugins/agent-codex/index.js';
import { proposerDefinition } from '../plugins/proposer-agent/index.js';
import { gridProposerDefinition } from '../plugins/proposer-grid/index.js';
import { optunaProposerDefinition } from '../plugins/proposer-optuna/index.js';
import { memoryDefinition } from '../plugins/memory-agent/index.js';
import { reflectionDefinition } from '../plugins/reflection-agent/index.js';
import { agentbenchDefinition } from '../plugins/evaluator-agentbench/index.js';
import { inferencebenchDefinition } from '../plugins/evaluator-inferencebench/index.js';
import { metricSelectorDefinition } from '../plugins/selector-metrics/index.js';
import { artifactSelectorDefinition } from '../plugins/selector-artifacts/index.js';
import type { OperationDefinition } from '../contracts/index.js';
/** Startup code is the sole built-in registration list. Registration never runs an experiment. */
export async function registerBuiltins(registry: Registry): Promise<void> {
  const definitions: OperationDefinition[] = [
    agentbundleDefinition,
    inferenceDefinition,
    piDefinition,
    codexDefinition,
    proposerDefinition,
    gridProposerDefinition,
    optunaProposerDefinition,
    memoryDefinition,
    reflectionDefinition,
    agentbenchDefinition,
    inferencebenchDefinition,
    metricSelectorDefinition,
    artifactSelectorDefinition,
  ];
  for (const definition of definitions) registry.registerOperation(definition);
  for (const path of [
    'harness2/policy.yaml',
    'wikiskill/policy.yaml',
    'parameter-grid/policy.yaml',
    'parameter-optuna/policy.yaml',
  ]) {
    const file = fileURLToPath(new URL(`../policies/${path}`, import.meta.url));
    const policy = await readPolicy(file, registry);
    registry.registerPolicy(String(policy.definition.id), file);
  }
}
