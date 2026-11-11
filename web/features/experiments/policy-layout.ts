import type {
  PolicyStructure,
  StructureDataEdge,
  StructureDataNode,
  StructureFlowEdge,
} from '../../../src/contracts/policy-structure.js';

export interface GraphBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface GraphPath {
  id: string;
  path: string;
  label: string;
  labelX: number;
  labelY: number;
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
export const dataNodeWidth = 286;
export const dataHeaderHeight = 64;
export const dataPortHeight = 28;

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

/** A focus includes only incident edges. State readers do not gain indirect writers. */
export function focusedPolicyData(
  model: PolicyStructure,
  stepId: string | null,
): { nodes: StructureDataNode[]; edges: StructureDataEdge[] } {
  if (!stepId) return model.data;
  const edges = model.data.edges.filter(
    (edge) => edge.source.nodeId === stepId || edge.target.nodeId === stepId,
  );
  const ids = new Set([
    stepId,
    ...edges.flatMap((edge) => [edge.source.nodeId, edge.target.nodeId]),
  ]);
  return { nodes: model.data.nodes.filter((node) => ids.has(node.id)), edges };
}

/** Hierarchy owns positions; edges are routed from the semantic model without inferring execution. */
export function layoutPolicyFlow(
  model: PolicyStructure,
  expanded: ReadonlySet<string>,
): PolicyLayout {
  const steps = new Map(model.steps.map((step) => [step.id, step]));
  const scopes = new Map(model.scopes.map((scope) => [scope.id, scope]));
  const flowNodes = new Map(model.flow.nodes.map((node) => [node.id, node]));
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
    const size = {
      width: Math.max(stepWidth, ...children.map((child) => child.width)) + 48,
      height: Math.max(
        132,
        children.reduce((sum, child) => sum + child.height, 0) +
          Math.max(0, children.length - 1) * 72 +
          112,
      ),
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
    nodes.push({
      id: scope.entryId,
      x: x + size.width / 2 - 10,
      y: y + 24,
      width: 20,
      height: 20,
    });
    let childY = y + 62;
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
      x: x + size.width / 2 - 10,
      y: y + size.height - 30,
      width: 20,
      height: 20,
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
    labelX: backwards ? lane : (fromX + toX) / 2 + 8,
    labelY: (fromY + toY) / 2 - 5,
    sourceId: source.id,
    targetId: target.id,
    kind: edge.kind,
    dynamic: false,
  };
}

/** Condense strongly connected components for columns; retain every original directed edge. */
export function layoutPolicyData(data: {
  nodes: StructureDataNode[];
  edges: StructureDataEdge[];
}): PolicyLayout {
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
  const columnHeights = new Map<number, number>();
  const nodes = data.nodes.map((node): GraphBox => {
    const column = rank[componentOf.get(node.id)!]!;
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
      labelX: (fromX + toX) / 2,
      labelY: backwards ? lane - 4 : (fromY + toY) / 2 - 6,
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
