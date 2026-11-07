import type {
  EvaluatorConfig,
  SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';

export { configSchema } from '../shared/evaluator-adapter/configuration.js';
/** AgentBench requires the Recipe to supply complete SDK services. */
export type AgentbenchConfig = EvaluatorConfig &
  Pick<SdkEvaluatorConfig, 'services'>;
