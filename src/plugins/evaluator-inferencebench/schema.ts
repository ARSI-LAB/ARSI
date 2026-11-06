import type { ServiceInput } from 'ember-evaluator';
import type { EvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';

export { configSchema } from '../shared/evaluator-adapter/configuration.js';

/** The selected service's model and endpoint are supplied by the Application. */
export type InferencebenchConfig = Omit<EvaluatorConfig, 'services'> & {
  services: Record<
    string,
    Omit<ServiceInput, 'model' | 'base_url'> &
      Partial<Pick<ServiceInput, 'model' | 'base_url'>>
  >;
};
