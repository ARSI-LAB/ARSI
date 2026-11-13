import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '../../contracts/json.js';
import { recipeDeclarationSchema } from '../../contracts/recipe.js';
import { digest, object, string } from '../../shared/json.js';
import type { PolicyStructure } from '../../shared/observation/policy-structure.js';
import { validate } from '../../shared/schema.js';
import { redactText } from '../../shared/secrets.js';
import {
  projectPolicyStructure,
  unavailablePolicyStructure,
  policyStructureLimits,
} from '../compiler/policy-structure.js';
import { parseLockedReflection } from '../manager/definition-lock.js';

class DefinitionLockError extends Error {
  constructor(
    readonly category: 'unsupported-source' | 'invalid-source',
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionLockError';
  }
}

/** Validate the saved read boundary without loading plugins or restoring resources. */
function readDefinitionLock(locked: JsonObject): {
  definitionDigest: string;
  policy: JsonObject;
  recipe: JsonObject;
  reflection: JsonValue | null;
} {
  if (locked.schemaVersion !== 'rsi.definition-lock/v1')
    throw new DefinitionLockError(
      'unsupported-source',
      'Unsupported saved definition version.',
    );
  const { digest: expected, ...content } = locked;
  if (typeof expected !== 'string' || expected !== digest(content))
    throw new DefinitionLockError(
      'invalid-source',
      'Saved definition digest does not match its contents.',
    );
  try {
    const policy = object(locked.policy, 'locked policy');
    const recipe = object(locked.recipe, 'locked recipe');
    if (
      policy.schemaVersion !== 'rsi.policy/v1' ||
      recipe.schemaVersion !== 'rsi.recipe/v1'
    )
      throw new DefinitionLockError(
        'unsupported-source',
        'Unsupported saved Policy or Recipe version.',
      );
    validate(recipeDeclarationSchema, recipe, 'locked recipe');
    const policyId = string(policy.id, 'locked policy.id');
    if (!policyId || object(recipe.policy).id !== policyId)
      throw new Error('Saved Policy identity mismatch');
    object(policy.input_schema, 'locked policy.input_schema');
    if (typeof policy.output_schema !== 'boolean')
      object(policy.output_schema, 'locked policy.output_schema');
    if (!Object.hasOwn(policy, 'output'))
      throw new Error('Saved Policy output declaration is missing');
    for (const field of [
      'input',
      'state',
      'require',
      'defaults',
      'config_schema',
      'state_schema',
    ])
      if (policy[field] !== undefined)
        object(policy[field], `locked policy.${field}`);
    if (locked.reflection !== null && locked.reflection !== undefined)
      parseLockedReflection(locked.reflection);
    return {
      definitionDigest: expected,
      policy,
      recipe,
      reflection: locked.reflection ?? null,
    };
  } catch (error) {
    if (error instanceof DefinitionLockError) throw error;
    // Persisted declarations may contain credentials; do not relay validator excerpts.
    throw new DefinitionLockError(
      'invalid-source',
      'Saved definition contains invalid Policy, Recipe, or Reflection data.',
    );
  }
}

/** Redact source text and identities consistently, keeping protocol enums intact. */
function redactStructureStrings(
  model: PolicyStructure,
  secrets: string[],
): PolicyStructure {
  const text = (value: string): string => redactText(value, secrets);
  // Redaction must not collapse distinct endpoint identities into one placeholder.
  const identity = (value: string): string =>
    text(value) === value
      ? value
      : `redacted:${createHash('sha256').update(value).digest('hex')}`;
  const optional = (value: string | null): string | null =>
    value === null ? null : text(value);
  const optionalIdentity = (value: string | null): string | null =>
    value === null ? null : identity(value);
  return {
    ...model,
    source: {
      ...model.source,
      experimentId: text(model.source.experimentId),
      policyId: optional(model.source.policyId),
      definitionDigest: optional(model.source.definitionDigest),
    },
    steps: model.steps.map((step) => ({
      ...step,
      id: identity(step.id),
      localId: text(step.localId),
      label: text(step.label),
      location: text(step.location),
      scopeId: identity(step.scopeId),
      childScopeIds: step.childScopeIds.map(identity),
      detailId: identity(step.detailId),
    })),
    scopes: model.scopes.map((scope) => ({
      ...scope,
      id: identity(scope.id),
      parentStepId: optionalIdentity(scope.parentStepId),
      location: text(scope.location),
      stepIds: scope.stepIds.map(identity),
      entryId: identity(scope.entryId),
      exitId: identity(scope.exitId),
    })),
    flow: {
      nodes: model.flow.nodes.map((node) => ({
        ...node,
        id: identity(node.id),
        stepId: optionalIdentity(node.stepId),
        scopeId: identity(node.scopeId),
        label: text(node.label),
      })),
      edges: model.flow.edges.map((edge) => ({
        ...edge,
        id: identity(edge.id),
        source: identity(edge.source),
        target: identity(edge.target),
        label: optional(edge.label),
        location: text(edge.location),
      })),
    },
    data: {
      nodes: model.data.nodes.map((node) => ({
        ...node,
        id: identity(node.id),
        stepId: optionalIdentity(node.stepId),
        scopeId: identity(node.scopeId),
        detailId: identity(node.detailId),
        label: text(node.label),
        ports: node.ports.map((port) => ({
          ...port,
          id: identity(port.id),
          label: text(port.label),
          path: port.path.map(text),
          location: text(port.location),
        })),
      })),
      edges: model.data.edges.map((edge) => ({
        ...edge,
        id: identity(edge.id),
        source: {
          nodeId: identity(edge.source.nodeId),
          portId: identity(edge.source.portId),
        },
        target: {
          nodeId: identity(edge.target.nodeId),
          portId: identity(edge.target.portId),
        },
        label: optional(edge.label),
        location: text(edge.location),
      })),
    },
    details: model.details.map((detail) => ({
      ...detail,
      id: identity(detail.id),
      bindingId: optionalIdentity(detail.bindingId),
      expressionPreviews: detail.expressionPreviews
        ?.filter(
          (preview) =>
            preview.kind !== 'range' ||
            [preview.start, preview.end].every(
              (bound) => text(String(bound)) === String(bound),
            ),
        )
        .map((preview) => ({
          ...preview,
          location: text(preview.location),
          ...(preview.kind === 'config'
            ? { path: preview.path.map(text) }
            : {}),
        })),
    })),
    bindings: model.bindings.map((binding) => ({
      ...binding,
      id: identity(binding.id),
      name: text(binding.name),
      contract: optional(binding.contract),
      plugin: optional(binding.plugin),
    })),
    diagnostics: model.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      nodeId: optionalIdentity(diagnostic.nodeId),
      location: optional(diagnostic.location),
      message: text(diagnostic.message),
    })),
  };
}

interface PolicyStructureQuery {
  readDefinition: () => Promise<JsonObject>;
  collectSecrets: (locked: JsonObject) => Promise<string[]>;
  clean: (
    value: JsonValue,
    secrets: string[],
    redactKeys?: boolean,
  ) => JsonValue;
  isSecretField: (field: string) => boolean;
  pluginDescriptions?: () => (id: string) => string | undefined;
}

/** Project the initial saved declaration through the same redaction as other observations. */
export async function queryPolicyStructure(
  id: string,
  {
    readDefinition,
    collectSecrets,
    clean,
    isSecretField,
    pluginDescriptions,
  }: PolicyStructureQuery,
): Promise<PolicyStructure> {
  let locked: JsonObject;
  try {
    locked = await readDefinition();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return unavailablePolicyStructure(
        id,
        'missing-source',
        'No initial saved definition is available for this experiment.',
      );
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        /^(value: expected object|Expected finite JSON data|Forbidden key (?:__proto__|constructor|prototype))$/.test(
          error.message,
        ))
    )
      return unavailablePolicyStructure(
        id,
        'invalid-source',
        'The saved definition is not valid JSON.',
      );
    throw error;
  }
  // Bound analysis before parsing recursive templates; never return a silently shortened graph.
  if (
    Buffer.byteLength(JSON.stringify(locked), 'utf8') >
    policyStructureLimits.bytes
  )
    return unavailablePolicyStructure(
      id,
      'oversized',
      'The saved definition exceeds the 4 MiB visualization limit.',
    );
  const secrets = await collectSecrets(locked);
  let source: ReturnType<typeof readDefinitionLock>;
  try {
    source = readDefinitionLock(locked);
  } catch (error) {
    if (error instanceof DefinitionLockError)
      return unavailablePolicyStructure(id, error.category, error.message);
    throw error;
  }
  const config = object(source.recipe.policy).config;
  const model = projectPolicyStructure(
    { experimentId: id, ...source },
    {
      config: config === undefined ? undefined : clean(config, secrets),
      isVisible: (value, location) =>
        redactText(value, secrets) === value &&
        redactText(location, secrets) === location &&
        !location.split('/').some(isSecretField),
    },
  );
  for (const detail of model.details) {
    detail.declaration = clean(detail.declaration, secrets, true);
    detail.configuration = clean(detail.configuration, secrets, true);
    detail.expressionPreviews = detail.expressionPreviews?.map((preview) =>
      preview.kind === 'value'
        ? { ...preview, value: clean(preview.value, secrets, true) }
        : preview,
    );
  }
  for (const binding of model.bindings)
    binding.configuration = clean(binding.configuration, secrets, true);
  const redacted = redactStructureStrings(model, secrets);
  const bytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8');
  if (bytes > policyStructureLimits.bytes)
    return unavailablePolicyStructure(
      redacted.source.experimentId,
      'oversized',
      'The redacted structure exceeds the 4 MiB visualization limit.',
      redacted.source,
    );
  if (pluginDescriptions && model.bindings.some((binding) => binding.plugin)) {
    const describe = pluginDescriptions();
    let remaining = policyStructureLimits.bytes - bytes;
    for (const [index, { plugin }] of model.bindings.entries()) {
      if (!plugin) continue;
      const description = describe(plugin);
      if (!description?.trim()) continue;
      const pluginDescription = redactText(description, secrets).trim();
      // Appending the field replaces the closing brace with a comma and a field.
      const extra =
        Buffer.byteLength(JSON.stringify({ pluginDescription })) - 1;
      if (extra > remaining) continue;
      redacted.bindings[index]!.pluginDescription = pluginDescription;
      remaining -= extra;
    }
  }
  return redacted;
}
