import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../../contracts/json.js';
import { object } from '../../shared/json.js';
import { isStructureRangePreviewBounds } from '../../shared/observation/policy-range-preview.js';
import type {
  PolicyStructure,
  StructureDataEdge,
  StructureDataNode,
  StructureDiagnostic,
  StructureExpressionPreview,
  StructureFlowEdge,
  StructurePort,
  StructureScope,
  StructureStep,
} from '../../shared/observation/policy-structure.js';
import {
  compileExpression,
  evaluateExpressionAst,
  expressions,
  type ExpressionAst,
} from '../policy/expression.js';
import {
  ControlStep,
  ForEachStep,
  IfStep,
  InvokeStep,
  LoopStep,
  ReflectionStep,
  StateStep,
  parseSteps,
  type Step,
} from '../policy/steps.js';

/** Explicit rejection limits; graphs are never silently truncated. */
export const policyStructureLimits = {
  steps: 2_000,
  relationshipsAndPorts: 20_000,
  bytes: 4 * 1024 * 1024,
  depth: 64,
} as const;

export interface PolicyStructureInput {
  experimentId: string;
  definitionDigest: string;
  policy: JsonObject;
  recipe: JsonObject;
  reflection: JsonValue | null;
}

interface PreviewSource {
  config: JsonValue | undefined;
  isVisible: (value: string, location: string) => boolean;
}

export function unavailablePolicyStructure(
  experimentId: string,
  category: StructureDiagnostic['category'],
  message: string,
  source: { policyId?: string | null; definitionDigest?: string | null } = {},
): PolicyStructure {
  return {
    source: {
      experimentId,
      policyId: source.policyId ?? null,
      definitionDigest: source.definitionDigest ?? null,
      snapshot: 'initial',
    },
    availability: {
      overall: 'unavailable',
      flow: 'unavailable',
      data: 'unavailable',
      details: 'unavailable',
    },
    steps: [],
    scopes: [],
    flow: { nodes: [], edges: [] },
    data: { nodes: [], edges: [] },
    details: [],
    bindings: [],
    diagnostics: [
      { category, view: 'all', nodeId: null, location: null, message },
    ],
  };
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
function append(path: string, value: string | number): string {
  return `${path}/${escapePointer(String(value))}`;
}
class OversizedStructure extends Error {}
interface Frame {
  declared: Map<string, string>;
  completed: Set<string>;
}
interface Context {
  frames: Frame[];
  locals: Map<string, string>;
  roots: Set<string>;
}
interface Reference {
  parts: string[];
  dynamic: boolean;
}
interface StepRecord {
  step: Step;
  model: StructureStep;
  scope: StructureScope;
  exitId: string;
}

/** Enumerates both sides of conditionals and short-circuit expressions without evaluation. */
function references(ast: ExpressionAst, dynamic = false): Reference[] {
  if (ast.kind === 'literal') return [];
  if (ast.kind === 'path') return [{ parts: ast.parts, dynamic }];
  if (ast.kind === 'access') {
    return [...references(ast.object, true), ...references(ast.key)];
  }
  if (ast.kind === 'call')
    return ast.args.flatMap((argument) => references(argument));
  if (ast.kind === 'unary') return references(ast.operand);
  return [...references(ast.left), ...references(ast.right)];
}

const previewFunctions = new Set([
  'get',
  'length',
  'size',
  'some',
  'if',
  'concat',
  'append',
  'flatten',
  'compact',
  'pluck',
]);
const maxExpressionPreviewInputBytes = 16_384;
const maxExpressionPreviewBytes = 4_096;
const maxComputedPreviewBytes = 256 * 1024;

/** Collection operations are bounded by the input size for each operand occurrence. */
function canEvaluatePreview(ast: ExpressionAst): boolean {
  switch (ast.kind) {
    case 'literal':
    case 'path':
      return true;
    case 'access':
      return canEvaluatePreview(ast.object) && canEvaluatePreview(ast.key);
    case 'unary':
      return canEvaluatePreview(ast.operand);
    case 'binary':
      return canEvaluatePreview(ast.left) && canEvaluatePreview(ast.right);
    case 'call':
      return (
        previewFunctions.has(ast.name) && ast.args.every(canEvaluatePreview)
      );
  }
}

function configValue(
  config: JsonValue | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let value = config;
  for (const part of path) {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = Array.isArray(value) ? value[Number(part)] : value[part];
  }
  return value;
}

class Projection {
  readonly model: PolicyStructure;
  readonly records = new Map<string, StepRecord>();
  readonly nodes = new Map<string, StructureDataNode>();
  readonly scopes = new Map<string, StructureScope>();
  readonly sourceGroups = new Map<string, string>();
  readonly edgeKeys = new Set<string>();
  readonly configPreviewBytes = new Map<string, number>();
  readonly savedConfig: JsonValue | undefined;
  readonly rootId: string;
  readonly failureId: string;
  units = 0;
  computedPreviewBytes = 0;

  constructor(
    readonly input: PolicyStructureInput,
    readonly previewSource: PreviewSource,
  ) {
    this.savedConfig = object(input.recipe.policy ?? {}).config;
    this.model = unavailablePolicyStructure(input.experimentId, 'analysis', '');
    this.model.source.policyId =
      typeof input.policy.id === 'string' ? input.policy.id : null;
    this.model.source.definitionDigest = input.definitionDigest;
    this.model.availability = {
      overall: 'complete',
      flow: 'complete',
      data: 'complete',
      details: 'complete',
    };
    this.model.diagnostics = [];
    this.rootId = this.id('/steps');
    this.failureId = this.id('/$failure');
  }

  id(location: string): string {
    return `${this.input.definitionDigest}:${location}`;
  }
  unit(): void {
    if (++this.units > policyStructureLimits.relationshipsAndPorts)
      throw new OversizedStructure();
  }
  diagnostic(
    view: 'flow' | 'data' | 'details',
    nodeId: string | null,
    location: string,
    message: string,
    category: StructureDiagnostic['category'] = 'analysis',
  ): void {
    this.model.diagnostics.push({
      category,
      view,
      nodeId,
      location,
      message,
    });
    this.model.availability[view] = 'partial';
    this.model.availability.overall = 'partial';
  }
  flow(
    source: string,
    target: string,
    kind: StructureFlowEdge['kind'],
    location: string,
    label: string | null = null,
  ): void {
    this.unit();
    this.model.flow.edges.push({
      id: this.id(`/$flow/${this.model.flow.edges.length}`),
      source,
      target,
      kind,
      location,
      label,
    });
  }
  node(
    kind: StructureDataNode['kind'],
    location: string,
    label: string,
    scopeId: string,
    declaration: JsonValue,
    configuration: JsonValue = null,
    stepId: string | null = null,
  ): StructureDataNode {
    const id = this.id(location);
    const node: StructureDataNode = {
      id,
      kind,
      stepId,
      label,
      scopeId,
      detailId: id,
      ports: [],
    };
    this.nodes.set(id, node);
    this.model.data.nodes.push(node);
    this.model.details.push({
      id,
      declaration,
      configuration,
      bindingId: null,
    });
    return node;
  }
  port(
    nodeId: string,
    role: StructurePort['role'],
    path: string[],
    location: string,
    label?: string,
  ): StructurePort {
    const node = this.nodes.get(nodeId)!;
    const id = `${nodeId}#${role}${path.map((part) => `/${escapePointer(part)}`).join('')}`;
    const existing = node.ports.find((port) => port.id === id);
    if (existing) return existing;
    this.unit();
    const port: StructurePort = {
      id,
      role,
      path,
      location,
      label: label ?? (path.join('.') || '(whole object)'),
    };
    node.ports.push(port);
    return port;
  }
  edge(
    sourceNode: string,
    source: StructurePort,
    targetNode: string,
    target: StructurePort,
    kind: StructureDataEdge['kind'],
    location: string,
    dynamic = false,
    label: string | null = null,
  ): void {
    const key = JSON.stringify([
      sourceNode,
      source.id,
      targetNode,
      target.id,
      kind,
      location,
      dynamic,
      label,
    ]);
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.unit();
    this.model.data.edges.push({
      id: this.id(`/$data/${this.model.data.edges.length}`),
      source: { nodeId: sourceNode, portId: source.id },
      target: { nodeId: targetNode, portId: target.id },
      kind,
      location,
      dynamic,
      label,
    });
  }

  assign(
    steps: readonly Step[],
    location: string,
    parentStepId: string | null,
    region: StructureScope['region'],
    loop: StepRecord | null = null,
  ): StructureScope {
    const scopeId = this.id(location);
    const scope: StructureScope = {
      id: scopeId,
      parentStepId,
      region,
      location,
      stepIds: [],
      entryId: this.id(`${location}/$entry`),
      exitId: this.id(`${location}/$exit`),
    };
    this.scopes.set(scopeId, scope);
    this.model.scopes.push(scope);
    for (const [kind, id] of [
      ['entry', scope.entryId],
      ['exit', scope.exitId],
    ] as const)
      this.model.flow.nodes.push({
        id,
        kind,
        stepId: null,
        scopeId,
        label: `${region} ${kind}`,
      });
    let predecessor: string | null = scope.entryId;
    steps.forEach((step, index) => {
      if (this.model.steps.length >= policyStructureLimits.steps)
        throw new OversizedStructure();
      const path = append(location, index);
      const id = this.id(path);
      const compound =
        step instanceof IfStep ||
        step instanceof LoopStep ||
        step instanceof ForEachStep;
      const model: StructureStep = {
        id,
        localId: step.id,
        type: step.type,
        label: step.id,
        location: path,
        scopeId,
        childScopeIds: [],
        detailId: id,
      };
      const record: StepRecord = {
        step,
        model,
        scope,
        exitId: compound ? this.id(`${path}/$exit`) : id,
      };
      this.records.set(id, record);
      this.model.steps.push(model);
      scope.stepIds.push(id);
      this.model.flow.nodes.push({
        id,
        kind: 'step',
        stepId: id,
        scopeId,
        label: step.id,
      });
      if (compound)
        this.model.flow.nodes.push({
          id: record.exitId,
          kind: 'exit',
          stepId: id,
          scopeId,
          label: `${step.id} exit`,
        });
      this.node(
        'step',
        path,
        step.id,
        scopeId,
        step.toJSON(),
        step instanceof ReflectionStep ? this.input.reflection : null,
        id,
      );
      if (predecessor) this.flow(predecessor, id, 'sequence', path);
      if (step instanceof ControlStep) {
        const action = step.control.action;
        if (action === 'fail')
          this.flow(id, this.failureId, 'fail', `${path}/control`);
        else if (loop)
          this.flow(
            id,
            action === 'break' ? loop.exitId : loop.model.id,
            action,
            `${path}/control`,
          );
        else
          this.diagnostic(
            'flow',
            id,
            `${path}/control`,
            'Control transfer has no permitted enclosing loop.',
          );
        predecessor = null;
      } else predecessor = record.exitId;
      if (step instanceof IfStep) {
        for (const branch of ['then', 'else'] as const) {
          const block = branch === 'then' ? step.thenBranch : step.elseBranch;
          const child = this.assign(
            block.steps,
            `${path}/${branch}/steps`,
            id,
            branch,
            loop,
          );
          model.childScopeIds.push(child.id);
          this.flow(id, child.entryId, 'branch', `${path}/if`, branch);
          this.flow(
            child.exitId,
            record.exitId,
            'sequence',
            `${path}/${branch}`,
          );
        }
      } else if (step instanceof LoopStep || step instanceof ForEachStep) {
        const child = this.assign(
          step.steps,
          `${path}/steps`,
          id,
          step instanceof LoopStep ? 'iteration' : 'item',
          step instanceof LoopStep ? record : null,
        );
        model.childScopeIds.push(child.id);
        this.flow(
          id,
          child.entryId,
          'repetition',
          path,
          step instanceof LoopStep ? 'iteration' : 'per item',
        );
        this.flow(child.exitId, id, 'repetition', path, 'repeat');
        this.flow(id, record.exitId, 'branch', path, 'complete / empty');
      }
    });
    if (predecessor) this.flow(predecessor, scope.exitId, 'sequence', location);
    return scope;
  }

  resolve(
    reference: Reference,
    context: Context,
  ): { nodeId: string; path: string[] } | null {
    const [root, ...path] = reference.parts;
    if (root === 'steps') {
      if (path.length < 2 || path[1] !== 'output') return null;
      const name = path[0]!;
      const frame = [...context.frames]
        .reverse()
        .find((entry) => entry.declared.has(name));
      if (!frame?.completed.has(name)) return null;
      return { nodeId: frame.declared.get(name)!, path: path.slice(1) };
    }
    const local = context.locals.get(root!);
    if (local) return { nodeId: local, path };
    const global = context.roots.has(root!)
      ? this.sourceGroups.get(root!)
      : null;
    return global ? { nodeId: global, path } : null;
  }

  configurationReference(
    targetId: string,
    path: string[],
    dynamic: boolean,
  ): void {
    if (!this.records.has(targetId)) return;
    const detail = this.model.details.find((entry) => entry.id === targetId)!;
    const value = configValue(this.previewSource.config, path);
    const configuration =
      detail.configuration === null ? {} : object(detail.configuration);
    const fields = Array.isArray(configuration.configFields)
      ? configuration.configFields
      : [];
    if (
      !fields.some(
        (entry) => JSON.stringify(object(entry).path) === JSON.stringify(path),
      )
    )
      fields.push({
        path,
        available: value !== undefined,
        savedValue: value ?? null,
        dynamic,
      });
    detail.configuration = { ...configuration, configFields: fields };
  }

  previewReferenceBytes({ parts }: Reference): number {
    if (parts[0] !== 'config') return Infinity;
    const path = parts.slice(1);
    const key = JSON.stringify(path);
    const cached = this.configPreviewBytes.get(key);
    if (cached !== undefined) return cached;
    const saved = configValue(this.savedConfig, path);
    const visible = configValue(this.previewSource.config, path);
    const bytes =
      saved === undefined ? Infinity : Buffer.byteLength(JSON.stringify(saved));
    const availableBytes =
      bytes <= maxExpressionPreviewInputBytes &&
      isDeepStrictEqual(saved, visible)
        ? bytes
        : Infinity;
    this.configPreviewBytes.set(key, availableBytes);
    return availableBytes;
  }

  expressionPreview(
    ast: ExpressionAst,
    refs: Reference[],
    targetId: string,
    location: string,
    sourceText: string,
  ): StructureExpressionPreview | undefined {
    const { config, isVisible } = this.previewSource;
    if (ast.kind === 'path' && ast.parts[0] === 'config') {
      const path = ast.parts.slice(1);
      if (
        this.records.has(targetId) ||
        (isVisible(sourceText, location) &&
          path.every((part) => isVisible(part, location)))
      )
        return { location, kind: 'config', path };
      return undefined;
    }
    const range = ast.kind === 'call' && ast.name === 'range';
    if (
      !(range ? ast.args.every(canEvaluatePreview) : canEvaluatePreview(ast)) ||
      !isVisible(sourceText, location)
    )
      return undefined;
    let inputBytes = 0;
    for (const reference of refs) {
      inputBytes += this.previewReferenceBytes(reference);
      if (inputBytes > maxExpressionPreviewInputBytes) return undefined;
    }
    const environment = { config: config ?? null };
    try {
      if (range) {
        // Evaluate the bounds without building the array.
        const start = evaluateExpressionAst(ast.args[0]!, environment);
        const end = evaluateExpressionAst(ast.args[1]!, environment);
        if (
          typeof start === 'number' &&
          typeof end === 'number' &&
          isStructureRangePreviewBounds(start, end)
        )
          return { location, kind: 'range', start, end };
        return undefined;
      }
      const value = evaluateExpressionAst(ast, environment);
      const serialized = JSON.stringify(value);
      const bytes = Buffer.byteLength(serialized);
      if (
        bytes <= maxExpressionPreviewBytes &&
        this.computedPreviewBytes + bytes <= maxComputedPreviewBytes &&
        isVisible(serialized, location)
      ) {
        this.computedPreviewBytes += bytes;
        return { location, kind: 'value', value };
      }
    } catch {
      // An unavailable preview leaves the expression and its dependencies intact.
    }
    return undefined;
  }

  template(
    value: JsonValue,
    targetId: string,
    context: Context,
    location: string,
    path: string[],
    role: StructurePort['role'] = 'input',
    kind: StructureDataEdge['kind'] = 'reference',
    label: string | null = null,
  ): void {
    if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length === 0 && kind === 'output-mapping')
        this.port(targetId, role, path, location);
      for (const [key, child] of Object.entries(value))
        this.template(
          child,
          targetId,
          context,
          append(location, key),
          [...path, key],
          role,
          kind,
          label,
        );
      return;
    }
    if (typeof value !== 'string') {
      if (kind === 'output-mapping') this.port(targetId, role, path, location);
      return;
    }
    let ast: ExpressionAst | undefined;
    let refs: Reference[];
    try {
      const [source] = expressions(value);
      ast =
        source === undefined
          ? undefined
          : compileExpression(source, [...context.locals.keys()]);
      refs = ast ? references(ast) : [];
    } catch {
      this.diagnostic(
        'data',
        targetId,
        location,
        'This declared expression could not be analyzed.',
      );
      return;
    }
    if (ast) {
      const preview = this.expressionPreview(
        ast,
        refs,
        targetId,
        location,
        value,
      );
      if (preview) {
        const detail = this.model.details.find(
          (entry) => entry.id === targetId,
        )!;
        (detail.expressionPreviews ??= []).push(preview);
      }
    }
    if (refs.length === 0 && kind !== 'output-mapping') return;
    const target = this.port(targetId, role, path, location);
    for (const reference of refs) {
      const resolved = this.resolve(reference, context);
      if (!resolved) {
        this.diagnostic(
          'data',
          targetId,
          location,
          'A declared reference has no visible source in this scope.',
        );
        continue;
      }
      const node = this.nodes.get(resolved.nodeId)!;
      const collection = this.records.get(node.id)?.step instanceof ForEachStep;
      const sourcePath = collection ? ['output'] : resolved.path;
      const source = this.port(
        node.id,
        node.kind === 'step' ? 'output' : 'field',
        sourcePath,
        node.kind === 'step'
          ? `${this.records.get(node.id)!.model.location}/output`
          : node.id.slice(this.input.definitionDigest.length + 1),
        collection ? 'output (collection)' : undefined,
      );
      if (reference.parts[0] === 'config')
        this.configurationReference(targetId, resolved.path, reference.dynamic);
      this.edge(
        node.id,
        source,
        targetId,
        target,
        kind,
        location,
        reference.dynamic,
        collection && resolved.path.length > 1
          ? [label, `collection access: ${resolved.path.slice(1).join('.')}`]
              .filter(Boolean)
              .join(' · ')
          : label,
      );
    }
  }

  analyze(
    scope: StructureScope,
    parent: Context,
    output?: {
      value: JsonValue;
      targetId: string;
      location: string;
      prefix: string[];
      label?: string;
    },
  ): Context {
    const frame: Frame = {
      declared: new Map(
        scope.stepIds.map((id) => [this.records.get(id)!.step.id, id]),
      ),
      completed: new Set(),
    };
    const context: Context = { ...parent, frames: [...parent.frames, frame] };
    for (const id of scope.stepIds) {
      const { step, model } = this.records.get(id)!;
      const path = model.location;
      if (step instanceof InvokeStep) {
        this.template(step.inputTemplate, id, context, `${path}/with`, [
          'with',
        ]);
        const binding = this.model.bindings.find(
          (entry) => entry.name === step.bindingName,
        );
        this.model.details.find((entry) => entry.id === id)!.bindingId =
          binding?.id ?? null;
        if (
          !binding?.plugin ||
          !binding.contract ||
          binding.configuration === null
        )
          this.diagnostic(
            'details',
            id,
            `${path}/use`,
            'The saved effective binding is unavailable.',
            'missing-source',
          );
      } else if (step instanceof StateStep) {
        this.template(step.patchTemplate, id, context, `${path}/state`, [
          'state',
        ]);
        const stateId = this.sourceGroups.get('state')!;
        for (const key of Object.keys(step.patchTemplate)) {
          const source = this.port(
            id,
            'input',
            ['state', key],
            append(`${path}/state`, key),
          );
          const target = this.port(
            stateId,
            'field',
            [key],
            append('/state', key),
          );
          this.edge(
            id,
            source,
            stateId,
            target,
            'state-write',
            append(`${path}/state`, key),
          );
        }
      } else if (step instanceof IfStep) {
        this.template(
          step.condition,
          id,
          context,
          `${path}/if`,
          ['if'],
          'expression',
        );
        for (const branch of ['then', 'else'] as const) {
          const child = this.scopes.get(this.id(`${path}/${branch}/steps`))!;
          this.analyze(child, context, {
            value:
              branch === 'then'
                ? step.thenBranch.output
                : step.elseBranch.output,
            targetId: id,
            location: `${path}/${branch}/output`,
            prefix: ['output'],
            label: branch,
          });
        }
      } else if (step instanceof LoopStep) {
        const child = this.scopes.get(model.childScopeIds[0]!)!;
        const local = this.node(
          'loop',
          `${path}/$loop`,
          `loop · ${step.id}`,
          child.id,
          { index: 'Symbolic iteration index; runtime value is unknown.' },
        );
        const locals = new Map(context.locals).set('loop', local.id);
        this.template(
          step.maxIterations,
          id,
          context,
          `${path}/maxIterations`,
          ['maxIterations'],
          'expression',
        );
        this.template(
          step.condition,
          id,
          { ...context, locals },
          `${path}/while`,
          ['while'],
          'expression',
        );
        this.analyze(child, { ...context, locals });
        // The Runtime evaluates loop output in its enclosing scope, never the body frame.
        this.template(
          step.output,
          id,
          context,
          `${path}/output`,
          ['output'],
          'output',
          'output-mapping',
          'loop result',
        );
      } else if (step instanceof ForEachStep) {
        const child = this.scopes.get(model.childScopeIds[0]!)!;
        const local = this.node(
          'item',
          `${path}/$item`,
          `${step.itemName} · ${step.id}`,
          child.id,
          { name: step.itemName, source: step.items },
        );
        const locals = new Map(context.locals).set(step.itemName, local.id);
        this.template(
          step.items,
          id,
          context,
          `${path}/foreach`,
          ['foreach'],
          'expression',
        );
        const collection = this.port(
          id,
          'expression',
          ['foreach'],
          `${path}/foreach`,
        );
        const item = this.port(
          local.id,
          'field',
          [],
          `${path}/as`,
          `${step.itemName} (per item)`,
        );
        this.edge(
          id,
          collection,
          local.id,
          item,
          'item-binding',
          `${path}/foreach`,
          false,
          'symbolic per item',
        );
        this.template(
          step.concurrency,
          id,
          context,
          `${path}/concurrency`,
          ['concurrency'],
          'expression',
        );
        this.template(
          step.key,
          id,
          { ...context, locals },
          `${path}/key`,
          ['key'],
          'expression',
        );
        this.analyze(
          child,
          { ...context, locals },
          {
            value: step.output,
            targetId: id,
            location: `${path}/output`,
            prefix: ['output', '[]'],
            label: 'per-item output',
          },
        );
        const result = this.port(
          id,
          'output',
          ['output'],
          `${path}/output`,
          'output (collection)',
        );
        for (const port of this.nodes
          .get(id)!
          .ports.filter(
            (entry) => entry.role === 'output' && entry.path[1] === '[]',
          ))
          this.edge(
            id,
            port,
            id,
            result,
            'output-mapping',
            `${path}/output`,
            false,
            'collect per-item outputs',
          );
      } else if (
        step instanceof ControlStep &&
        step.control.action === 'fail'
      ) {
        this.template(
          step.control.reason,
          id,
          context,
          `${path}/reason`,
          ['reason'],
          'expression',
        );
      } else if (
        step instanceof ReflectionStep &&
        this.input.reflection === null
      ) {
        this.diagnostic(
          'details',
          id,
          path,
          'Initial saved Reflection configuration is unavailable.',
          'missing-source',
        );
      }
      if (!(step instanceof ControlStep)) frame.completed.add(step.id);
    }
    if (output)
      this.template(
        output.value,
        output.targetId,
        context,
        output.location,
        output.prefix,
        'output',
        'output-mapping',
        output.label ?? null,
      );
    return context;
  }

  run(steps: readonly Step[]): PolicyStructure {
    const root = this.assign(steps, '/steps', null, 'root');
    if (this.model.flow.edges.some((edge) => edge.kind === 'fail'))
      this.model.flow.nodes.push({
        id: this.failureId,
        kind: 'failure',
        stepId: null,
        scopeId: root.id,
        label: 'Failure',
      });
    const recipePolicy = object(this.input.recipe.policy ?? {});
    for (const kind of [
      'input',
      'config',
      'state',
      'application',
      'output',
    ] as const) {
      const declaration =
        kind === 'application'
          ? {
              description:
                'Application initialization result; runtime value is unknown.',
            }
          : (this.input.policy[kind] ??
            this.input.policy[`${kind}_schema`] ??
            null);
      const configuration =
        kind === 'input'
          ? (recipePolicy.input ?? null)
          : kind === 'config'
            ? (recipePolicy.config ?? null)
            : kind === 'application'
              ? (this.input.recipe.application ?? null)
              : null;
      const node = this.node(
        kind,
        `/$${kind}`,
        kind === 'output' ? 'Policy output' : kind,
        root.id,
        declaration,
        configuration,
      );
      this.sourceGroups.set(kind, node.id);
    }
    const requirements = object(this.input.policy.require ?? {});
    for (const [name, raw] of Object.entries(
      object(this.input.recipe.bindings ?? {}),
    )) {
      const binding = object(raw);
      const requirement =
        requirements[name] === undefined ? {} : object(requirements[name]);
      this.model.bindings.push({
        id: this.id(append('/$bindings', name)),
        name,
        contract:
          typeof requirement.contract === 'string'
            ? requirement.contract
            : null,
        plugin: typeof binding.plugin === 'string' ? binding.plugin : null,
        configuration: binding.config ?? null,
      });
    }
    const context: Context = {
      frames: [],
      locals: new Map(),
      roots: new Set(['application', 'config', 'input', 'state']),
    };
    this.template(
      this.input.policy.input ?? {},
      this.sourceGroups.get('input')!,
      { ...context, roots: new Set(['application', 'config']) },
      '/input',
      [],
      'field',
      'output-mapping',
      'input default',
    );
    // Recipe input is an expression-bearing template too. Keep declared defaults
    // visible as alternatives; this projection does not evaluate or prune them.
    this.template(
      recipePolicy.input ?? {},
      this.sourceGroups.get('input')!,
      { ...context, roots: new Set(['application', 'config']) },
      '/recipe/policy/input',
      [],
      'field',
      'output-mapping',
      'Recipe input',
    );
    this.template(
      this.input.policy.state ?? {},
      this.sourceGroups.get('state')!,
      { ...context, roots: new Set(['application', 'config', 'input']) },
      '/state',
      [],
      'field',
      'output-mapping',
      'initial state',
    );
    this.analyze(root, context, {
      value: this.input.policy.output ?? null,
      targetId: this.sourceGroups.get('output')!,
      location: '/output',
      prefix: [],
      label: 'Policy output',
    });
    if (
      Buffer.byteLength(JSON.stringify(this.model), 'utf8') >
      policyStructureLimits.bytes
    )
      throw new OversizedStructure();
    return this.model;
  }
}

/** Projects declarations and bounded previews from an authenticated saved lock. */
export function projectPolicyStructure(
  input: PolicyStructureInput,
  previewSource?: PreviewSource,
): PolicyStructure {
  const source = {
    policyId: typeof input.policy.id === 'string' ? input.policy.id : null,
    definitionDigest: input.definitionDigest,
  };
  if (input.policy.schemaVersion !== 'rsi.policy/v1')
    return unavailablePolicyStructure(
      input.experimentId,
      'unsupported-source',
      'The saved Policy version is unsupported.',
      source,
    );
  try {
    const pending: { value: JsonValue; depth: number }[] = [
      { value: input.policy, depth: 0 },
    ];
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (depth > policyStructureLimits.depth) throw new OversizedStructure();
      if (value && typeof value === 'object')
        for (const child of Object.values(value))
          pending.push({ value: child, depth: depth + 1 });
    }
    if (
      Buffer.byteLength(JSON.stringify(input), 'utf8') >
      policyStructureLimits.bytes
    )
      throw new OversizedStructure();
    let steps: readonly Step[];
    try {
      steps = parseSteps(input.policy.steps, 'saved policy');
    } catch {
      return unavailablePolicyStructure(
        input.experimentId,
        'invalid-source',
        'The saved Policy step declaration is invalid or unsupported.',
        source,
      );
    }
    return new Projection(
      input,
      previewSource ?? {
        config: object(input.recipe.policy ?? {}).config,
        isVisible: () => true,
      },
    ).run(steps);
  } catch (error) {
    if (error instanceof OversizedStructure)
      return unavailablePolicyStructure(
        input.experimentId,
        'oversized',
        'The saved structure exceeds the supported size or nesting limit.',
        source,
      );
    return unavailablePolicyStructure(
      input.experimentId,
      'analysis',
      'The saved structure could not be projected reliably.',
      source,
    );
  }
}
