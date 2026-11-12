import type {
  PolicyStructure,
  StructureDataEdge,
  StructureDataNode,
  StructureFlowEdge,
} from '../../../src/contracts/policy-structure.js';
import {
  compileExpression,
  expressions,
} from '../../../src/runtime/policy/expression-syntax.js';

export interface GraphBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataNodeId?: string;
}
export interface GraphPath {
  id: string;
  path: string;
  label: string;
  sourceId: string;
  targetId: string;
  kind: string;
  dynamic: boolean;
}
export interface PolicyLayout {
  nodes: GraphBox[];
  regions: (GraphBox & { label: string; empty: boolean })[];
  edges: GraphPath[];
  width: number;
  height: number;
}
const padding = 32;
const stepWidth = 264;
const anchorSize = { width: 20, height: 20 };
const policyBoundarySize = { width: 190, height: 48 };
export const dataNodeWidth = 286;
export const dataHeaderHeight = 64;
export const dataPortHeight = 28;

function fieldPathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const [prefix, path] =
    left.length <= right.length ? [left, right] : [right, left];
  // Distinct source fields can have the same display path after redaction.
  return prefix.every(
    (part, index) => part === path[index] && !part.includes('[REDACTED]'),
  );
}

/** Only ancestor containers are revealed, preserving unrelated expansion state. */
export function revealPolicyStep(
  model: PolicyStructure,
  stepId: string,
  expanded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(expanded);
  const steps = new Map(model.steps.map((step) => [step.id, step]));
  const scopes = new Map(model.scopes.map((scope) => [scope.id, scope]));
  let step = steps.get(stepId);
  while (step) {
    const parent = scopes.get(step.scopeId)?.parentStepId;
    if (!parent) break;
    next.add(parent);
    step = steps.get(parent);
  }
  return next;
}

/** Keep local dependencies and enough declared paths to orient them between Policy boundaries. */
export function focusedPolicyData(
  model: PolicyStructure,
  nodeId: string | null,
  expressionEdges?: ReadonlySet<string>,
): { nodes: StructureDataNode[]; edges: StructureDataEdge[] } {
  if (!nodeId) return model.data;
  const { nodes, edges } = model.data;
  const input = nodes.find((node) => node.kind === 'input');
  const output = nodes.find((node) => node.kind === 'output');
  const ids = new Set([nodeId]);
  if (input) ids.add(input.id);
  if (output) ids.add(output.id);

  const stateSteps = new Set(
    model.steps.filter((step) => step.type === 'state').map((step) => step.id),
  );
  const fieldPaths = new Map<string, string[]>();
  for (const node of nodes) {
    const isPatch = stateSteps.has(node.id);
    if (node.kind !== 'state' && !isPatch) continue;
    // Patch expressions and step outputs expose the same fields under different roots.
    for (const port of node.ports)
      fieldPaths.set(port.id, isPatch ? port.path.slice(1) : port.path);
  }

  const outgoing = new Map<
    string,
    Map<string | undefined, StructureDataEdge[]>
  >();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    hasIncoming.add(edge.target.nodeId);
    const { nodeId, portId } = edge.source;
    let byField = outgoing.get(nodeId);
    if (!byField) outgoing.set(nodeId, (byField = new Map()));
    const field = fieldPaths.get(portId)?.[0];
    const group = byField.get(field);
    if (group) group.push(edge);
    else byField.set(field, [edge]);
  }
  function matchesField(from: string, to: string): boolean {
    if (from === to) return true;
    const incoming = fieldPaths.get(from);
    const outgoing = fieldPaths.get(to);
    if (!incoming?.length || !outgoing?.length) return true;
    // Redacted paths can share display text despite different identities.
    if (from.startsWith('redacted:') || to.startsWith('redacted:'))
      return false;
    return fieldPathsOverlap(incoming, outgoing);
  }
  function edgesFrom(nodeId: string, portId?: string): StructureDataEdge[] {
    const byField = outgoing.get(nodeId);
    if (!byField) return [];
    const field =
      portId === undefined ? undefined : fieldPaths.get(portId)?.[0];
    if (field === undefined)
      return byField.size === 1
        ? byField.values().next().value!
        : [...byField.values()].flat();
    return [...(byField.get(field) ?? []), ...(byField.get(undefined) ?? [])];
  }
  function shortestPath(
    from: string | undefined,
    to: string | undefined,
  ): StructureDataEdge[] | undefined {
    if (from === undefined || to === undefined) return undefined;
    if (from === to) return [];
    if (!hasIncoming.has(to)) return undefined;
    const queue: {
      nodeId: string;
      via?: StructureDataEdge;
      previous: number;
    }[] = [{ nodeId: from, previous: -1 }];
    const visited = new Set([from]);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (current.nodeId === to) {
        const path: StructureDataEdge[] = [];
        for (let at = index; at !== 0; at = queue[at]!.previous)
          path.push(queue[at]!.via!);
        return path;
      }
      const arrival = current.via?.target.portId;
      for (const edge of edgesFrom(current.nodeId, arrival)) {
        if (arrival !== undefined && !matchesField(arrival, edge.source.portId))
          continue;
        const target = edge.target;
        const key = fieldPaths.has(target.portId)
          ? target.portId
          : target.nodeId;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ nodeId: target.nodeId, via: edge, previous: index });
      }
    }
    return undefined;
  }

  const upstream = shortestPath(input?.id, nodeId);
  const downstream = shortestPath(nodeId, output?.id);
  const context = new Set([
    ...(upstream ?? []),
    ...(downstream ?? []),
    ...(!upstream || !downstream
      ? (shortestPath(input?.id, output?.id) ?? [])
      : []),
  ]);
  const visible = edges.filter((edge) => {
    if (
      !context.has(edge) &&
      !expressionEdges?.has(edge.id) &&
      edge.source.nodeId !== nodeId &&
      edge.target.nodeId !== nodeId
    )
      return false;
    ids.add(edge.source.nodeId);
    ids.add(edge.target.nodeId);
    return true;
  });
  return { nodes: nodes.filter((node) => ids.has(node.id)), edges: visible };
}

/** Match a declaration location to its incoming data dependencies. */
export function policyExpressionReferences(
  model: PolicyStructure,
): ReadonlyMap<string, readonly StructureDataEdge[]> {
  const byLocation = new Map<string, StructureDataEdge[]>();
  if (model.availability.data === 'unavailable') return byLocation;
  for (const edge of model.data.edges) {
    if (
      edge.kind !== 'reference' &&
      (edge.kind !== 'output-mapping' ||
        edge.source.nodeId === edge.target.nodeId)
    )
      continue;
    const references = byLocation.get(edge.location);
    if (references) references.push(edge);
    else byLocation.set(edge.location, [edge]);
  }
  // Redaction can merge display locations even when the endpoints remain distinct.
  for (const [location, edges] of byLocation) {
    const target = edges[0]!.target;
    if (
      edges.some(
        (edge) =>
          edge.target.nodeId !== target.nodeId ||
          edge.target.portId !== target.portId,
      )
    )
      byLocation.delete(location);
  }
  return byLocation;
}

interface PolicyExpressionFocus {
  target: StructureDataEdge['target'];
  edges: ReadonlySet<string>;
  ports: ReadonlySet<string>;
  writesState: boolean;
}

/** Follow declared inputs and readers of the shared state fields an expression uses. */
export function policyExpressionNavigation(model: PolicyStructure): {
  references: ReturnType<typeof policyExpressionReferences>;
  canFocus: (location: string, value: string) => boolean;
  focus: (location: string) => PolicyExpressionFocus | undefined;
} {
  const references = policyExpressionReferences(model);
  const state =
    model.availability.data === 'unavailable'
      ? undefined
      : model.data.nodes.find((node) => node.kind === 'state');
  const statePaths = new Map(state?.ports.map((port) => [port.id, port.path]));
  const writes = new Map<string, StructureDataEdge | null>();
  const stateInputs: StructureDataEdge[] = [];
  const stateReads: StructureDataEdge[] = [];
  if (state) {
    for (const edge of model.data.edges) {
      if (
        edge.target.nodeId === state.id &&
        (edge.kind === 'state-write' || edge.kind === 'output-mapping')
      ) {
        stateInputs.push(edge);
        if (edge.kind === 'state-write') {
          // Distinct paths can share a displayed location after redaction.
          writes.set(edge.location, writes.has(edge.location) ? null : edge);
        }
      } else if (
        edge.source.nodeId === state.id &&
        (edge.kind === 'reference' || edge.kind === 'output-mapping')
      ) {
        stateReads.push(edge);
      }
    }
  }
  function statePortsOverlap(leftId: string, rightId: string): boolean {
    if (leftId === rightId) return true;
    const left = statePaths.get(leftId);
    const right = statePaths.get(rightId);
    return (
      left !== undefined &&
      right !== undefined &&
      fieldPathsOverlap(left, right)
    );
  }
  function writeAt(location: string): StructureDataEdge | undefined {
    // State patches replace top-level fields, including expressions nested within them.
    for (
      let path = location;
      path.startsWith('/');
      path = path.slice(0, path.lastIndexOf('/'))
    ) {
      const write = writes.get(path);
      if (write !== undefined) return write ?? undefined;
    }
    return undefined;
  }
  return {
    references,
    canFocus(location, value) {
      if (references.has(location)) return true;
      if (!writeAt(location)) return false;
      try {
        const [source] = expressions(value);
        if (source === undefined) return false;
        compileExpression(source);
        return true;
      } catch {
        return false;
      }
    },
    focus(location) {
      const incoming = references.get(location) ?? [];
      const incomingTarget = incoming[0]?.target;
      const write = writeAt(location);
      const matchingWrite =
        write &&
        (!incomingTarget || incomingTarget.nodeId === write.source.nodeId)
          ? write
          : undefined;
      const target = incomingTarget ?? matchingWrite?.source;
      if (!target) return undefined;
      const edges = [...incoming];
      const readPorts = incoming
        .filter((edge) => edge.source.nodeId === state?.id)
        .map((edge) => edge.source.portId);
      if (readPorts.length) {
        for (const edge of stateInputs) {
          // A state step reads the state before applying its own patch.
          if (edge.source.nodeId === target.nodeId) continue;
          if (
            readPorts.some((port) =>
              statePortsOverlap(edge.target.portId, port),
            )
          )
            edges.push(edge);
        }
      }
      if (matchingWrite) {
        edges.push(matchingWrite);
        for (const edge of stateReads) {
          // The writer's own expressions read the state before its patch.
          if (edge.target.nodeId === target.nodeId) continue;
          if (
            statePortsOverlap(matchingWrite.target.portId, edge.source.portId)
          )
            edges.push(edge);
        }
      }
      return {
        target,
        edges: new Set(edges.map((edge) => edge.id)),
        ports: new Set(
          edges.flatMap((edge) => [edge.source.portId, edge.target.portId]),
        ),
        writesState: matchingWrite !== undefined,
      };
    },
  };
}

/** Hierarchy owns positions; edges are routed from the semantic model without inferring execution. */
export function layoutPolicyFlow(
  model: PolicyStructure,
  expanded: ReadonlySet<string>,
): PolicyLayout {
  const steps = new Map(model.steps.map((step) => [step.id, step]));
  const scopes = new Map(model.scopes.map((scope) => [scope.id, scope]));
  const flowNodes = new Map(model.flow.nodes.map((node) => [node.id, node]));
  const boundaries = new Map<
    string,
    Pick<GraphBox, 'width' | 'height' | 'dataNodeId'>
  >();
  for (const node of model.data.nodes) {
    if (node.kind !== 'input' && node.kind !== 'output') continue;
    const scope = scopes.get(node.scopeId);
    if (scope?.parentStepId === null) {
      const id = node.kind === 'input' ? scope.entryId : scope.exitId;
      boundaries.set(id, { ...policyBoundarySize, dataNodeId: node.id });
    }
  }
  const sizes = new Map<string, { width: number; height: number }>();
  function measureStep(id: string): { width: number; height: number } {
    const known = sizes.get(id);
    if (known) return known;
    const step = steps.get(id)!;
    const children = expanded.has(id)
      ? step.childScopeIds.map(measureScope)
      : [];
    const size = children.length
      ? {
          width: Math.max(
            stepWidth,
            children.reduce((sum, child) => sum + child.width, 0) +
              (children.length + 1) * 24,
          ),
          height: 96 + Math.max(...children.map((child) => child.height)) + 28,
        }
      : { width: stepWidth, height: 82 };
    sizes.set(id, size);
    return size;
  }
  function measureScope(id: string): { width: number; height: number } {
    const scope = scopes.get(id)!;
    const children = scope.stepIds.map(measureStep);
    const entry = boundaries.get(scope.entryId) ?? anchorSize;
    const exit = boundaries.get(scope.exitId) ?? anchorSize;
    const size = {
      width: Math.max(stepWidth, ...children.map((child) => child.width)) + 48,
      height:
        Math.max(
          132,
          children.reduce((sum, child) => sum + child.height, 0) +
            Math.max(0, children.length - 1) * 72 +
            112,
        ) +
        (entry.height + exit.height - 2 * anchorSize.height),
    };
    sizes.set(id, size);
    return size;
  }
  const nodes: GraphBox[] = [];
  const regions: PolicyLayout['regions'] = [];
  function placeScope(id: string, x: number, y: number): void {
    const scope = scopes.get(id)!;
    const size = sizes.get(id)!;
    if (scope.parentStepId !== null)
      regions.push({
        id,
        x,
        y,
        ...size,
        label:
          scope.region === 'item'
            ? 'Per item'
            : scope.region === 'iteration'
              ? 'Iteration'
              : scope.region,
        empty: scope.stepIds.length === 0,
      });
    const centerX = x + size.width / 2;
    const entry = boundaries.get(scope.entryId) ?? anchorSize;
    const exit = boundaries.get(scope.exitId) ?? anchorSize;
    nodes.push({
      id: scope.entryId,
      x: centerX - entry.width / 2,
      y: y + 24,
      ...entry,
    });
    let childY = y + 24 + entry.height + 18;
    for (const childId of scope.stepIds) {
      const childSize = sizes.get(childId)!;
      const childX = x + (size.width - childSize.width) / 2;
      nodes.push({ id: childId, x: childX, y: childY, ...childSize });
      const child = steps.get(childId)!;
      if (expanded.has(child.id)) {
        let regionX = childX + 24;
        for (const regionId of child.childScopeIds) {
          placeScope(regionId, regionX, childY + 96);
          regionX += sizes.get(regionId)!.width + 24;
        }
      }
      childY += childSize.height + 72;
    }
    nodes.push({
      id: scope.exitId,
      x: centerX - exit.width / 2,
      y: y + size.height - 10 - exit.height,
      ...exit,
    });
  }
  let graphWidth = 0,
    graphHeight = 0;
  for (const root of model.scopes.filter(
    (scope) => scope.parentStepId === null,
  )) {
    const size = measureScope(root.id);
    placeScope(root.id, padding + graphWidth, padding);
    graphWidth += size.width + padding;
    graphHeight = Math.max(graphHeight, size.height);
  }
  for (const node of model.flow.nodes.filter(
    (node) => node.kind === 'failure',
  )) {
    nodes.push({
      id: node.id,
      x: graphWidth + 24,
      y: padding + graphHeight / 2,
      width: 100,
      height: 36,
    });
  }
  const stepBoxes = new Map(nodes.map((node) => [node.id, node]));
  for (const anchor of model.flow.nodes) {
    if (
      anchor.kind !== 'exit' ||
      !anchor.stepId ||
      !expanded.has(anchor.stepId)
    )
      continue;
    const owner = stepBoxes.get(anchor.stepId);
    if (owner)
      nodes.push({
        id: anchor.id,
        x: owner.x + owner.width / 2 - 10,
        y: owner.y + owner.height - 25,
        width: 20,
        height: 20,
      });
  }
  const boxes = new Map(nodes.map((node) => [node.id, node]));
  function visibleId(id: string): string | null {
    if (boxes.has(id)) return id;
    const node = flowNodes.get(id);
    if (node?.stepId && boxes.has(node.stepId)) return node.stepId;
    let scope = node ? scopes.get(node.scopeId) : undefined;
    while (scope?.parentStepId) {
      if (boxes.has(scope.parentStepId)) return scope.parentStepId;
      const parent = steps.get(scope.parentStepId);
      scope = parent ? scopes.get(parent.scopeId) : undefined;
    }
    return null;
  }
  const edges: GraphPath[] = [];
  const seen = new Set<string>();
  for (const edge of model.flow.edges) {
    const sourceId = visibleId(edge.source),
      targetId = visibleId(edge.target);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const key = JSON.stringify([sourceId, targetId, edge.kind, edge.label]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(
      flowPath(
        edge,
        boxes.get(sourceId)!,
        boxes.get(targetId)!,
        expanded,
        edges.length,
      ),
    );
  }
  return {
    nodes,
    regions,
    edges,
    width: Math.max(
      360,
      graphWidth +
        (model.flow.nodes.some((node) => node.kind === 'failure') ? 180 : 80),
    ),
    height: Math.max(260, graphHeight + padding * 2),
  };
}

function flowPath(
  edge: StructureFlowEdge,
  source: GraphBox,
  target: GraphBox,
  expanded: ReadonlySet<string>,
  index: number,
): GraphPath {
  const fromX = source.x + source.width / 2;
  const toX = target.x + target.width / 2;
  const fromY =
    source.y +
    (expanded.has(source.id) &&
    (edge.kind === 'branch' || edge.kind === 'repetition')
      ? 78
      : source.height);
  const toY = target.y;
  const exitsExpandedContainer =
    expanded.has(source.id) &&
    edge.kind === 'branch' &&
    target.y > source.y + source.height - 40;
  const backwards =
    toY <= fromY ||
    exitsExpandedContainer ||
    ['break', 'continue', 'fail'].includes(edge.kind);
  const lane =
    Math.max(source.x + source.width, target.x + target.width) +
    12 +
    (index % 5) * 7;
  const path = backwards
    ? `M ${source.x + source.width} ${source.y + Math.min(42, source.height / 2)} C ${lane} ${source.y + 42}, ${lane} ${toY + 10}, ${target.x + target.width} ${toY + 10}`
    : `M ${fromX} ${fromY} C ${fromX} ${(fromY + toY) / 2}, ${toX} ${(fromY + toY) / 2}, ${toX} ${toY}`;
  return {
    id: edge.id,
    path,
    label: edge.label ?? (edge.kind === 'sequence' ? '' : edge.kind),
    sourceId: source.id,
    targetId: target.id,
    kind: edge.kind,
    dynamic: false,
  };
}

/** Condense strongly connected components for columns; retain every original directed edge. */
export function layoutPolicyData(
  data: { nodes: StructureDataNode[]; edges: StructureDataEdge[] },
  focusId: string | null = null,
): PolicyLayout {
  const adjacency = new Map(
    data.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of data.edges)
    adjacency.get(edge.source.nodeId)?.add(edge.target.nodeId);
  let sequence = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    stacked = new Set<string>();
  const components: string[][] = [];
  function visit(id: string): void {
    indices.set(id, sequence);
    low.set(id, sequence++);
    stack.push(id);
    stacked.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (stacked.has(target))
        low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let item: string;
      do {
        item = stack.pop()!;
        stacked.delete(item);
        component.push(item);
      } while (item !== id);
      components.push(component);
    }
  }
  for (const node of data.nodes) if (!indices.has(node.id)) visit(node.id);
  const componentOf = new Map(
    components.flatMap((items, index) =>
      items.map((id): [string, number] => [id, index]),
    ),
  );
  const outgoing = components.map(() => new Set<number>()),
    incoming = components.map(() => 0),
    rank = components.map(() => 0);
  for (const edge of data.edges) {
    const from = componentOf.get(edge.source.nodeId)!,
      to = componentOf.get(edge.target.nodeId)!;
    if (from !== to && !outgoing[from]!.has(to)) {
      outgoing[from]!.add(to);
      incoming[to] = incoming[to]! + 1;
    }
  }
  const queue = incoming.flatMap((count, index) =>
    count === 0 ? [index] : [],
  );
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const from = queue[cursor]!;
    for (const to of outgoing[from]!) {
      rank[to] = Math.max(rank[to]!, rank[from]! + 1);
      incoming[to] = incoming[to]! - 1;
      if (incoming[to] === 0) queue.push(to);
    }
  }
  const rankOf = (id: string): number => rank[componentOf.get(id)!]!;
  const input = focusId && data.nodes.find((node) => node.kind === 'input');
  const output = focusId && data.nodes.find((node) => node.kind === 'output');
  // Keep the boundaries around the focus when a declared path is missing.
  const offset =
    input &&
    input.id !== focusId &&
    rankOf(input.id) === 0 &&
    rankOf(focusId) === 0
      ? 1
      : 0;
  const columnOf = (id: string): number =>
    rankOf(id) + (input && id === input.id ? 0 : offset);
  const outputColumn = output
    ? data.nodes.reduce(
        (column, node) =>
          node.id === output.id
            ? column
            : Math.max(column, columnOf(node.id) + 1),
        columnOf(output.id),
      )
    : 0;
  const columnHeights = new Map<number, number>();
  const nodes = data.nodes.map((node): GraphBox => {
    const column =
      output && node.id === output.id ? outputColumn : columnOf(node.id);
    const y = columnHeights.get(column) ?? padding + 24;
    const height =
      dataHeaderHeight + Math.max(1, node.ports.length) * dataPortHeight + 12;
    columnHeights.set(column, y + height + 70);
    return {
      id: node.id,
      x: padding + column * (dataNodeWidth + 150),
      y,
      width: dataNodeWidth,
      height,
    };
  });
  const boxes = new Map(nodes.map((node) => [node.id, node]));
  const portRows = new Map(
    data.nodes.map((node) => [
      node.id,
      new Map(node.ports.map((port, index) => [port.id, index])),
    ]),
  );
  const edges = data.edges.map((edge, index): GraphPath => {
    const source = boxes.get(edge.source.nodeId)!,
      target = boxes.get(edge.target.nodeId)!;
    const fromX = source.x + source.width,
      toX = target.x;
    const fromY =
      source.y +
      dataHeaderHeight +
      portRows.get(source.id)!.get(edge.source.portId)! * dataPortHeight +
      dataPortHeight / 2;
    const toY =
      target.y +
      dataHeaderHeight +
      portRows.get(target.id)!.get(edge.target.portId)! * dataPortHeight +
      dataPortHeight / 2;
    const backwards = toX <= fromX;
    const lane = Math.min(source.y, target.y) - 20 - (index % 5) * 6;
    const path = backwards
      ? `M ${fromX} ${fromY} C ${fromX + 40} ${fromY}, ${fromX + 40} ${lane}, ${fromX} ${lane} L ${toX - 30} ${lane} C ${toX - 50} ${lane}, ${toX - 50} ${toY}, ${toX} ${toY}`
      : `M ${fromX} ${fromY} C ${(fromX + toX) / 2} ${fromY}, ${(fromX + toX) / 2} ${toY}, ${toX} ${toY}`;
    return {
      id: edge.id,
      sourceId: source.id,
      targetId: target.id,
      path,
      label: [
        edge.dynamic ? 'dynamic' : '',
        edge.label ?? (edge.kind === 'reference' ? '' : edge.kind),
      ]
        .filter(Boolean)
        .join(' · '),
      kind: edge.kind,
      dynamic: edge.dynamic,
    };
  });
  return {
    nodes,
    regions: [],
    edges,
    width: Math.max(420, ...nodes.map((node) => node.x + node.width + 80)),
    height: Math.max(
      240,
      ...nodes.map((node) => node.y + node.height + padding),
    ),
  };
}
