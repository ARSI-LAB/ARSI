import type { JsonObject } from '../../contracts/index.js';
import type { Registry } from '../../runtime/registry/index.js';
import { readPolicy } from '../../runtime/compiler/index.js';

/** Compatibility denotes declared contract slots, not measured task suitability. */
export async function describeCatalog(
  registry: Registry,
): Promise<{ plugins: JsonObject[]; policies: JsonObject[] }> {
  const catalog = registry.catalog();
  const policies = await Promise.all(
    catalog.policies.map(async (id) => ({
      id,
      policy: await readPolicy(registry.policy(id), registry),
    })),
  );
  return {
    plugins: catalog.plugins.map((id) => {
      const plugin = registry.get(id);
      return {
        id,
        description: plugin.description ?? null,
        contract: plugin.contract.id,
        input_schema: plugin.contract.input_schema,
        output_schema: plugin.contract.output_schema,
        config_schema: plugin.configSchema,
        compatiblePolicies: policies.flatMap(({ id, policy }) =>
          Object.entries(policy.requirements)
            .filter(([, contract]) => contract.id === plugin.contract.id)
            .map(([binding]) => ({ policy: id, binding })),
        ),
      };
    }),
    policies: policies.map(({ id, policy }) => ({
      id,
      description: policy.description ?? null,
      input_schema: policy.inputSchema,
      output_schema: policy.outputSchema,
      config_schema: policy.configSchema ?? {
        type: 'object',
        additionalProperties: false,
      },
      require: Object.fromEntries(
        Object.entries(policy.requirements).map(([binding, contract]) => [
          binding,
          {
            contract: contract.id,
            plugins: catalog.plugins.filter(
              (id) => registry.get(id).contract.id === contract.id,
            ),
          },
        ]),
      ),
      defaults: policy.defaults,
    })),
  };
}
