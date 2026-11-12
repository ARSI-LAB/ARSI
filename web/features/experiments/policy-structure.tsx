import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { JsonValue } from '../../../src/contracts/json.js';
import {
  parsePolicyStructure,
  type PolicyStructure as PolicyStructureModel,
  type StructureDataNode,
  type StructureDetail,
  type StructureStep,
} from '../../api/observation-client';
import { Feedback } from '../../components/observation-feedback';
import { useObservation } from './use-observation';
import {
  describePolicyExpression,
  type PolicyExpressionDescription,
} from './policy-expression-description';
import { resolvePolicyExpressionPreview } from './policy-expression-preview';
import {
  dataHeaderHeight,
  dataPortHeight,
  focusedPolicyData,
  layoutPolicyData,
  layoutPolicyFlow,
  policyExpressionNavigation,
  revealPolicyStep,
  type PolicyLayout,
} from './policy-layout';
import { PolicyViewport, type PolicyViewportState } from './policy-viewport';
import { PolicyWorkspace } from './policy-workspace';

type View = 'flow' | 'data';
type DescribeExpression = (
  value: string,
  location: string,
) => PolicyExpressionDescription | undefined;

function position(box: PolicyLayout['nodes'][number]): React.CSSProperties {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

function dataNodeLabel(node: StructureDataNode): string {
  if (node.kind === 'input') return 'Policy Input';
  if (node.kind === 'output') return 'Policy Output';
  return node.label;
}

interface PolicyNodeAppearance {
  label: string;
  mark: string;
}

const stepAppearance = {
  invoke: { label: 'Plugin call', mark: '◆' },
  state: { label: 'State update', mark: '✎' },
  if: { label: 'If branch', mark: '⑂' },
  loop: { label: 'Loop', mark: '↻' },
  foreach: { label: 'For each', mark: '▦' },
  control: { label: 'Control', mark: '■' },
  reflection: { label: 'Reflection', mark: '✦' },
} satisfies Record<StructureStep['type'], PolicyNodeAppearance>;

const dataAppearance = {
  step: { label: 'Step', mark: '–' },
  input: { label: 'Input', mark: '⇥' },
  output: { label: 'Output', mark: '↗' },
  config: { label: 'Config', mark: '⚙︎' },
  state: { label: 'Shared state', mark: '▤' },
  application: { label: 'Application', mark: '▣' },
  loop: { label: 'Loop index', mark: '#' },
  item: { label: 'Item', mark: '●' },
} satisfies Record<StructureDataNode['kind'], PolicyNodeAppearance>;

function PolicyNodeKind({
  appearance,
  label = appearance.label,
}: {
  appearance: PolicyNodeAppearance;
  label?: string;
}): React.JSX.Element {
  return (
    <span className="policy-node-kind">
      <span className="policy-node-mark" aria-hidden="true">
        {appearance.mark}
      </span>
      {label}
    </span>
  );
}

function stepSubtitle(
  step: StructureStep,
  detail: StructureDetail | undefined,
  describeExpression: DescribeExpression,
): string {
  const value = detail?.declaration;
  const declaration =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const display = (field: string, fallback = 'not declared'): string => {
    const location = `${step.location}/${field}`;
    const preview = detail && resolvePolicyExpressionPreview(detail, location);
    const value =
      preview?.kind === 'value'
        ? preview.value
        : (preview?.label ?? declaration[field]);
    if (value === undefined) return fallback;
    if (typeof value !== 'string') return JSON.stringify(value);
    return preview
      ? value
      : (describeExpression(value, location)?.text ?? value);
  };
  switch (step.type) {
    case 'invoke':
      return `Binding: ${display('use')}`;
    case 'if':
      return `If: ${display('if')}`;
    case 'loop':
      return `Limit: ${display('maxIterations')}`;
    case 'foreach':
      return `Concurrency: ${display('concurrency', 'default')}`;
    case 'control':
      return `Action: ${display('control')}`;
    case 'state': {
      const fields = declaration.state;
      return `Writes: ${fields && typeof fields === 'object' && !Array.isArray(fields) ? Object.keys(fields).join(', ') || '(none)' : 'not declared'}`;
    }
    case 'reflection':
      return 'Initial saved configuration';
  }
}

export function PolicyStructure({ id }: { id: string }): React.JSX.Element {
  const result = useObservation(
    `/${encodeURIComponent(id)}/policy-structure`,
    parsePolicyStructure,
    null,
    true,
  );
  return (
    <section className="policy-structure" aria-label="Policy structure">
      <Feedback {...result} />
      {result.data ? (
        <PolicyGraphs
          key={`${id}:${result.data.source.definitionDigest}`}
          model={result.data}
        />
      ) : null}
    </section>
  );
}

export function PolicyGraphs({
  model,
}: {
  model: PolicyStructureModel;
}): React.JSX.Element {
  const detailsId = useId();
  const [view, setView] = useState<View>('flow');
  const [selected, setSelected] = useState<string | null>(null);
  const [activeExpression, setActiveExpression] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [fullData, setFullData] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [viewports, setViewports] = useState<
    Record<View, PolicyViewportState | null>
  >({ flow: null, data: null });
  const revealSequence = useRef(0);
  const [reveal, setReveal] = useState<{
    id: string | null;
    token: number;
    view: View;
    focusCanvas: boolean;
  } | null>(null);
  const steps = useMemo(
    () => new Map(model.steps.map((step) => [step.id, step])),
    [model],
  );
  const dataNodes = useMemo(
    () => new Map(model.data.nodes.map((node) => [node.id, node])),
    [model],
  );
  const flowNodes = useMemo(
    () => new Map(model.flow.nodes.map((node) => [node.id, node])),
    [model],
  );
  const flowLayout = useMemo(
    () => layoutPolicyFlow(model, expanded),
    [model, expanded],
  );
  const expressionNavigation = useMemo(
    () => policyExpressionNavigation(model),
    [model],
  );
  const expressionHighlights = useMemo(
    () =>
      view === 'data' && activeExpression !== null
        ? expressionNavigation.focus(activeExpression)
        : undefined,
    [activeExpression, expressionNavigation, view],
  );
  const dataFocus = fullData ? null : focus;
  const focusTarget = selected && dataNodes.has(selected) ? selected : focus;
  const visibleData = useMemo(
    () => focusedPolicyData(model, dataFocus, expressionHighlights?.edges),
    [model, dataFocus, expressionHighlights],
  );
  const dataLayout = useMemo(
    () => layoutPolicyData(visibleData, dataFocus),
    [visibleData, dataFocus],
  );
  const layout = view === 'flow' ? flowLayout : dataLayout;
  const onViewport = useCallback(
    (next: React.SetStateAction<PolicyViewportState | null>) =>
      setViewports((previous) => ({
        ...previous,
        [view]: typeof next === 'function' ? next(previous[view]) : next,
      })),
    [view],
  );
  const selectedNode = selected
    ? view === 'flow'
      ? (steps.get(selected) ?? dataNodes.get(selected))
      : dataNodes.get(selected)
    : undefined;
  const childSteps = useMemo(() => {
    if (view !== 'flow' || !selected) return undefined;
    const scopes = model.scopes.filter(
      (scope) => scope.parentStepId === selected,
    );
    if (!scopes.length) return undefined;
    return new Map(
      scopes.map((scope) => [
        scope.location,
        scope.stepIds.flatMap((id) => {
          const child = steps.get(id);
          return child ? [child] : [];
        }),
      ]),
    );
  }, [model.scopes, selected, steps, view]);
  const flowEndpoint =
    selected && !steps.has(selected)
      ? flowLayout.nodes.find((box) => box.dataNodeId === selected)
      : undefined;
  function describeExpression(
    value: string,
    location: string,
  ): PolicyExpressionDescription | undefined {
    const localNames = expressionNavigation.references
      .get(location)
      ?.flatMap((edge) => {
        const source = dataNodes.get(edge.source.nodeId);
        if (source?.kind !== 'item') return [];
        const declaration = model.details.find(
          (detail) => detail.id === source.detailId,
        )?.declaration;
        return declaration &&
          typeof declaration === 'object' &&
          !Array.isArray(declaration) &&
          typeof declaration.name === 'string'
          ? [declaration.name]
          : [];
      });
    return describePolicyExpression(value, localNames);
  }
  const revealBox =
    reveal?.view === view
      ? layout.nodes.find((node) => node.id === reveal.id)
      : undefined;
  const revealTarget = useMemo(() => {
    if (reveal?.view !== view || (reveal.id !== null && !revealBox))
      return null;
    return {
      token: reveal.token,
      box: revealBox,
      focusCanvas: reveal.focusCanvas,
    };
  }, [reveal, revealBox, view]);

  function revealInView(
    id: string | null,
    next: View,
    focusCanvas = false,
  ): void {
    setReveal({
      id,
      view: next,
      token: ++revealSequence.current,
      focusCanvas,
    });
  }
  function focusDataNode(
    id: string,
    expression?: { location: string; focusCanvas: boolean },
  ): void {
    setSelected(id);
    setFocus(id);
    setActiveExpression(expression?.location ?? null);
    setFullData(false);
    setViewports((previous) => ({ ...previous, data: null }));
    if (expression?.focusCanvas) revealInView(null, 'data', true);
    else setReveal(null);
    setView('data');
  }
  function showChildStep(id: string): void {
    setSelected(id);
    setExpanded((current) => revealPolicyStep(model, id, current));
    revealInView(id, 'flow', true);
  }
  function showExpression(location: string): void {
    const expression = expressionNavigation.focus(location);
    if (!expression) return;
    focusDataNode(expression.target.nodeId, {
      location,
      focusCanvas: !expression.writesState,
    });
  }
  function switchView(next: View): void {
    if (next === view) return;
    const step = selected ? steps.get(selected) : undefined;
    const destination =
      next === 'flow'
        ? (step?.id ?? flowEndpoint?.id)
        : selected && (step || flowEndpoint) && dataNodes.has(selected)
          ? selected
          : undefined;
    if (next === 'data' && destination) {
      focusDataNode(destination);
      return;
    }
    setActiveExpression(null);
    if (destination) {
      if (step)
        setExpanded((current) => revealPolicyStep(model, step.id, current));
      revealInView(destination, next);
    } else {
      setSelected(null);
      setReveal(null);
      if (next === 'data') setFullData(true);
    }
    setView(next);
  }
  const focusedDataNode = dataFocus ? dataNodes.get(dataFocus) : undefined;
  function toggle(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <header className="policy-heading">
        <div>
          <h2>Policy structure</h2>
          <p>
            {model.source.policyId ?? 'Policy unavailable'}{' '}
            <span className="policy-snapshot">Initial snapshot</span>
          </p>
        </div>
        <p
          className="policy-source"
          title={model.source.definitionDigest ?? undefined}
        >
          Saved definition{' '}
          <code>
            {model.source.definitionDigest?.slice(0, 16) ?? 'unavailable'}
          </code>
        </p>
      </header>
      <p className="policy-description">
        Declared structure and dependencies from the saved snapshot. Runtime
        values and execution outcomes are unknown.
      </p>
      <div className="policy-toolbar">
        <div className="policy-segment" aria-label="Policy graph view">
          <button
            type="button"
            aria-pressed={view === 'flow'}
            onClick={() => switchView('flow')}
          >
            Flow
          </button>
          <button
            type="button"
            aria-pressed={view === 'data'}
            onClick={() => switchView('data')}
          >
            Data
          </button>
        </div>
        {view === 'data' ? (
          <div className="policy-segment" aria-label="Data graph extent">
            <button
              type="button"
              aria-pressed={!!dataFocus}
              disabled={!focusTarget}
              onClick={() => focusTarget && focusDataNode(focusTarget)}
            >
              Focused
            </button>
            <button
              type="button"
              aria-pressed={!dataFocus}
              onClick={() => {
                setFullData(true);
                setActiveExpression(null);
              }}
            >
              Full graph
            </button>
          </div>
        ) : null}
        <span className="policy-graph-count">
          {view === 'flow'
            ? `${layout.nodes.filter((node) => steps.has(node.id)).length} of ${model.steps.length} steps`
            : `${visibleData.nodes.length} groups · ${visibleData.edges.length} relationships`}
        </span>
      </div>
      {model.availability.overall !== 'complete' ||
      model.diagnostics.length > 0 ? (
        <div className="policy-diagnostics" role="status">
          <strong>Analysis {model.availability.overall}</strong>
          <span>
            Flow: {model.availability.flow} · Data: {model.availability.data} ·
            Details: {model.availability.details}
          </span>
          <ul>
            {model.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <span>
                  {diagnostic.view}: {diagnostic.message}
                </span>
                {diagnostic.location ? (
                  <code>{diagnostic.location}</code>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view === 'data' && dataFocus ? (
        <p className="policy-focus-caption">
          {expressionHighlights?.writesState
            ? 'State write and declared readers for '
            : 'Declared dependencies around '}
          <strong>
            {focusedDataNode
              ? dataNodeLabel(focusedDataNode)
              : 'selected group'}
          </strong>
          .
        </p>
      ) : null}
      <PolicyWorkspace
        detailsId={detailsId}
        fullData={view === 'data' && !dataFocus}
        hasSelection={!!selectedNode}
        inputFocus={expressionHighlights !== undefined}
        details={
          <PolicyDetails
            id={detailsId}
            model={model}
            view={view}
            node={selectedNode}
            childSteps={childSteps}
            canShowExpression={expressionNavigation.canFocus}
            describeExpression={describeExpression}
            onShowStep={showChildStep}
            onShowExpression={showExpression}
            onClose={() => {
              setSelected(null);
              setActiveExpression(null);
            }}
          />
        }
      >
        {model.availability[view] === 'unavailable' ? (
          <div className="policy-empty">
            <h3>{view === 'flow' ? 'Flow' : 'Data'} view unavailable</h3>
            <p>
              The saved definition could not provide a reliable model for this
              view.
            </p>
          </div>
        ) : layout.nodes.length === 0 ? (
          <div className="policy-empty">
            <h3>
              No declared {view === 'flow' ? 'steps' : 'data relationships'}
            </h3>
            <p>This saved snapshot has no nodes in this view.</p>
          </div>
        ) : (
          <PolicyViewport
            key={view}
            width={layout.width}
            height={layout.height}
            viewport={viewports[view]}
            onViewport={onViewport}
            reveal={revealTarget}
          >
            {view === 'flow'
              ? layout.nodes
                  .filter(
                    (box) =>
                      expanded.has(box.id) &&
                      steps.get(box.id)?.childScopeIds.length,
                  )
                  .map((box) => (
                    <div
                      key={`container:${box.id}`}
                      className="policy-container"
                      style={position(box)}
                    />
                  ))
              : null}
            {layout.regions.map((region) => (
              <div
                key={region.id}
                className="policy-region"
                style={position(region)}
              >
                <span>{region.label}</span>
                {region.empty ? <small>Empty branch</small> : null}
              </div>
            ))}
            <PolicyEdges
              layout={layout}
              selected={
                view === 'flow' ? (flowEndpoint?.id ?? selected) : selected
              }
              view={view}
              inputEdges={expressionHighlights?.edges}
            />
            {layout.nodes.map((box) => {
              if (view === 'data') {
                const node = dataNodes.get(box.id)!;
                const stepType = node.stepId
                  ? steps.get(node.stepId)?.type
                  : undefined;
                return (
                  <DataNode
                    key={box.id}
                    node={node}
                    stepType={stepType}
                    box={box}
                    selected={selected === box.id}
                    highlightedPorts={expressionHighlights?.ports}
                    onSelect={() => setSelected(box.id)}
                    onFocusNode={() => focusDataNode(box.id)}
                  />
                );
              }
              const step = steps.get(box.id);
              if (!step) {
                const endpoint = box.dataNodeId
                  ? dataNodes.get(box.dataNodeId)
                  : undefined;
                if (endpoint) {
                  return (
                    <button
                      key={box.id}
                      type="button"
                      className="policy-flow-endpoint"
                      style={position(box)}
                      aria-pressed={selected === endpoint.id}
                      onClick={() => setSelected(endpoint.id)}
                    >
                      <PolicyNodeKind
                        appearance={dataAppearance[endpoint.kind]}
                        label={dataNodeLabel(endpoint)}
                      />
                    </button>
                  );
                }
                const anchor = flowNodes.get(box.id);
                return anchor ? (
                  <div
                    key={box.id}
                    className={`policy-anchor policy-anchor-${anchor.kind}`}
                    style={position(box)}
                    title={`${anchor.label} (structural boundary)`}
                  >
                    <span>{anchor.label}</span>
                  </div>
                ) : null;
              }
              const detail = model.details.find(
                (detail) => detail.id === step.detailId,
              );
              const subtitle = stepSubtitle(step, detail, describeExpression);
              return (
                <div
                  key={box.id}
                  className="policy-step"
                  data-step-id={step.id}
                  data-selected={selected === step.id}
                  data-type={step.type}
                  style={{ ...position(box), height: 82 }}
                >
                  <button
                    type="button"
                    className="policy-node-select"
                    onClick={() => setSelected(step.id)}
                    aria-pressed={selected === step.id}
                    title={`${step.label}\n${step.location}`}
                  >
                    <PolicyNodeKind appearance={stepAppearance[step.type]} />
                    <strong>{step.label}</strong>
                    <small title={subtitle}>{subtitle}</small>
                  </button>
                  {step.childScopeIds.length ? (
                    <button
                      type="button"
                      className="policy-expand"
                      onClick={() => toggle(step.id)}
                      aria-expanded={expanded.has(step.id)}
                      aria-label={`${expanded.has(step.id) ? 'Collapse' : 'Expand'} ${step.label}`}
                    >
                      {expanded.has(step.id) ? '−' : '+'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </PolicyViewport>
        )}
      </PolicyWorkspace>
      <p className="policy-legend">
        {view === 'flow'
          ? 'Top → bottom · Branches are alternatives · Containers represent declared bodies once'
          : 'Left → right · Arrowheads preserve dependency direction, including cycles · Dashed = dynamic access'}
      </p>
    </>
  );
}

function PolicyEdges({
  layout,
  selected,
  view,
  inputEdges,
}: {
  layout: PolicyLayout;
  selected: string | null;
  view: View;
  inputEdges?: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <svg
      className="policy-edges"
      width={layout.width}
      height={layout.height}
      aria-label={`${view} relationships`}
    >
      <defs>
        <marker
          id={`policy-arrow-${view}`}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
        </marker>
      </defs>
      {layout.edges.map((edge) => (
        <g
          key={edge.id}
          className="policy-edge"
          data-active={
            inputEdges?.has(edge.id) ??
            (edge.sourceId === selected || edge.targetId === selected)
          }
          data-dynamic={edge.dynamic}
          data-kind={edge.kind}
        >
          <title>{edge.label || edge.kind}</title>
          <path d={edge.path} markerEnd={`url(#policy-arrow-${view})`} />
        </g>
      ))}
    </svg>
  );
}

function DataNode({
  node,
  stepType,
  box,
  selected,
  highlightedPorts,
  onSelect,
  onFocusNode,
}: {
  node: StructureDataNode;
  stepType: StructureStep['type'] | undefined;
  box: PolicyLayout['nodes'][number];
  selected: boolean;
  highlightedPorts?: ReadonlySet<string>;
  onSelect: () => void;
  onFocusNode: () => void;
}): React.JSX.Element {
  const label = dataNodeLabel(node);
  return (
    <section
      className="policy-data-node"
      data-selected={selected}
      data-type={stepType ?? node.kind}
      style={position(box)}
      aria-label={label}
    >
      <button
        type="button"
        className="policy-data-node-control"
        onClick={onSelect}
        onDoubleClick={onFocusNode}
        aria-label={label}
        aria-pressed={selected}
        title={`${label} · Double-click to focus`}
      >
        <span
          className="policy-node-select"
          style={{ height: dataHeaderHeight }}
        >
          <PolicyNodeKind
            appearance={
              stepType ? stepAppearance[stepType] : dataAppearance[node.kind]
            }
          />
          <strong>{label}</strong>
        </span>
        <span className="policy-ports">
          {node.ports.length ? (
            node.ports.map((port) => (
              <span
                key={port.id}
                className="policy-port"
                data-role={port.role}
                data-highlighted={highlightedPorts?.has(port.id)}
                style={{ height: dataPortHeight }}
                title={`${port.label}\n${port.location}`}
              >
                <span className="policy-port-dot" />
                <code>{port.label}</code>
                <span className="policy-port-dot" />
              </span>
            ))
          ) : (
            <span className="policy-no-ports">No referenced fields</span>
          )}
        </span>
      </button>
    </section>
  );
}

const stepTypeDescriptions: Record<StructureStep['type'], string> = {
  invoke: 'Calls a plugin through its declared binding.',
  state: 'Updates shared state for later steps or iterations.',
  if: 'Chooses a branch based on a condition.',
  loop: 'Repeats a group of steps up to a limit, with an optional stop condition.',
  foreach:
    'Runs a group of steps for each item in a collection, with optional concurrency.',
  control: 'Breaks a loop, skips to its next iteration, or fails the workflow.',
  reflection:
    'Uses execution evidence to propose updates to target plugin resources.',
};

function PolicyValueHelp({
  label,
  text,
}: {
  label: string;
  text: string;
}): React.JSX.Element {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="policy-type-help"
      data-dismissed={dismissed}
      onMouseEnter={() => setDismissed(false)}
    >
      <button
        type="button"
        className="policy-type-help-trigger"
        aria-label={label}
        aria-describedby={tooltipId}
        onFocus={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDismissed(true);
        }}
      >
        i
      </button>
      <span id={tooltipId} className="policy-type-help-tooltip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

interface PolicyDeclarationActions {
  step: StructureStep | undefined;
  detail: StructureDetail | undefined;
  rootConfig: JsonValue | undefined;
  view: View;
  childSteps: ReadonlyMap<string, readonly StructureStep[]> | undefined;
  canShowExpression: (location: string, value: string) => boolean;
  describeExpression: DescribeExpression;
  onShowStep: (id: string) => void;
  onShowExpression: (location: string) => void;
  onShowBinding: (() => void) | undefined;
}

const forEachFieldLabels: Readonly<Record<string, string>> = {
  foreach: 'Items',
  as: 'Item variable',
  key: 'Item key',
  concurrency: 'Concurrency',
};

function PolicyValueBranch({
  name,
  count,
  unit,
  children,
}: {
  name: string;
  count: number;
  unit: 'item' | 'field';
  children: React.ReactNode;
}): React.JSX.Element {
  const [visited, setVisited] = useState(false);
  return (
    <details
      className="policy-value-branch"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <summary>
        <span className="policy-value-row">
          <code className="policy-value-key">{name || '""'}</code>
          <span className="policy-value-count">
            {count} {unit}
            {count === 1 ? '' : 's'}
          </span>
        </span>
      </summary>
      {visited ? children : null}
    </details>
  );
}

function PolicyExpressionOperands({
  operands,
}: {
  operands: NonNullable<PolicyExpressionDescription['operands']>;
}): React.JSX.Element {
  return (
    <details className="policy-expression-operands">
      <summary>Nested operations</summary>
      <ul>
        {operands.map(({ label, description }) => (
          <li key={label}>
            <span className="policy-value-key">{label}</span>
            <span className="policy-expression-caption">
              {description.text}
            </span>
            {description.operands?.length ? (
              <PolicyExpressionOperands operands={description.operands} />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PolicyValueList({
  value,
  location,
  itemSourceLocation,
  actions,
}: {
  value: JsonValue;
  location: string | undefined;
  itemSourceLocation?: string;
  actions: PolicyDeclarationActions | undefined;
}): React.JSX.Element {
  const array = Array.isArray(value);
  const hasEntries = value !== null && typeof value === 'object';
  const entries: [string, JsonValue][] = hasEntries
    ? Object.entries(value)
    : [['Value', value]];
  if (entries.length === 0)
    return (
      <p className="policy-detail-empty">Empty {array ? 'array' : 'object'}</p>
    );
  const step = actions?.step;
  const stepField = step !== undefined && location === step.location;
  const foreach = step?.type === 'foreach';
  const inputLocation =
    step?.type === 'invoke' ? `${step.location}/with` : undefined;
  return (
    <ul className="policy-value-list">
      {entries.map(([key, rawValue]) => {
        if (foreach && stepField && key === 'key' && actions?.view === 'flow')
          return null;
        const fieldLocation =
          itemSourceLocation !== undefined && key === 'source'
            ? itemSourceLocation
            : hasEntries && location !== undefined
              ? `${location}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
              : location;
        const childSteps =
          fieldLocation !== undefined && Array.isArray(rawValue)
            ? actions?.childSteps?.get(fieldLocation)
            : undefined;
        if (actions && childSteps) {
          return (
            <li key={key}>
              {childSteps.length ? (
                <PolicyValueBranch
                  name={key}
                  count={childSteps.length}
                  unit="item"
                >
                  <ul
                    className="policy-value-list policy-child-steps"
                    aria-label="Child steps"
                  >
                    {childSteps.map((child) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          className="policy-value-data policy-value-action"
                          title="Show step in Flow"
                          onClick={() => actions.onShowStep(child.id)}
                        >
                          {child.localId}
                        </button>
                      </li>
                    ))}
                  </ul>
                </PolicyValueBranch>
              ) : (
                <div className="policy-value-row">
                  <code className="policy-value-key">{key}</code>
                  <span className="policy-detail-empty">No steps</span>
                </div>
              )}
            </li>
          );
        }
        const isInput =
          inputLocation !== undefined && fieldLocation === inputLocation;
        const foreachLabel =
          foreach && stepField ? forEachFieldLabels[key] : undefined;
        const name =
          foreachLabel ?? (isInput ? 'Input' : array ? `[${key}]` : key);
        const isExpressionField =
          fieldLocation !== undefined && typeof rawValue === 'string';
        const preview =
          isExpressionField && actions?.view === 'flow' && actions.detail
            ? resolvePolicyExpressionPreview(
                actions.detail,
                fieldLocation,
                actions.rootConfig,
              )
            : undefined;
        const description = isExpressionField
          ? actions?.describeExpression(rawValue, fieldLocation)
          : undefined;
        const operands = description?.operands?.length ? (
          <PolicyExpressionOperands operands={description.operands} />
        ) : null;
        const value =
          preview?.kind === 'value'
            ? preview.value
            : (preview?.label ?? rawValue);
        const help =
          (preview || description) && typeof rawValue === 'string' ? (
            <PolicyValueHelp
              label={`Original expression for ${name}`}
              text={rawValue}
            />
          ) : stepField && key === 'type' && step ? (
            <PolicyValueHelp
              label={`About ${step.type} steps`}
              text={stepTypeDescriptions[step.type]}
            />
          ) : null;
        const collection = value !== null && typeof value === 'object';
        const count = collection
          ? Array.isArray(value)
            ? value.length
            : Object.keys(value).length
          : 0;
        const bindingField = inputLocation && stepField && key === 'use';
        let showField: (() => void) | undefined;
        if (typeof rawValue === 'string' && actions) {
          if (bindingField) showField = actions.onShowBinding;
          else if (
            fieldLocation !== undefined &&
            actions.canShowExpression(fieldLocation, rawValue)
          )
            showField = () => actions.onShowExpression(fieldLocation);
        }
        if (collection && count > 0) {
          const branch = (
            <PolicyValueBranch
              name={name}
              count={count}
              unit={Array.isArray(value) ? 'item' : 'field'}
            >
              <PolicyValueList
                value={value}
                location={fieldLocation}
                actions={preview ? undefined : actions}
              />
            </PolicyValueBranch>
          );
          return (
            <li key={key}>
              {help || showField ? (
                <div className="policy-value-branch-with-actions">
                  {branch}
                  <span className="policy-value-branch-actions">
                    {showField ? (
                      <button
                        type="button"
                        className="policy-value-data policy-value-action"
                        onClick={showField}
                      >
                        Show in Data
                      </button>
                    ) : null}
                    {help}
                  </span>
                </div>
              ) : (
                branch
              )}
              {description ? (
                <div className="policy-expression-preview-caption">
                  {description.text}
                  {operands}
                </div>
              ) : null}
            </li>
          );
        }
        const label = collection
          ? Array.isArray(value)
            ? '[]'
            : '{}'
          : value === ''
            ? '""'
            : String(value);
        const descriptionIsLabel = description !== undefined && !preview;
        const displayLabel = descriptionIsLabel ? description.text : label;
        return (
          <li key={key}>
            <div className="policy-value-row">
              <code className="policy-value-key">{name || '""'}</code>
              <span>
                <span
                  className={
                    descriptionIsLabel ? 'policy-expression-label' : undefined
                  }
                >
                  {showField ? (
                    <button
                      type="button"
                      className={`policy-value-data policy-value-action${descriptionIsLabel ? ' policy-expression-text' : ''}`}
                      title={
                        bindingField
                          ? 'Go to saved effective binding'
                          : inputLocation &&
                              (isInput ||
                                fieldLocation?.startsWith(`${inputLocation}/`))
                            ? 'Show input relationships in Data'
                            : 'Show dependencies in Data'
                      }
                      onClick={showField}
                    >
                      {displayLabel}
                    </button>
                  ) : descriptionIsLabel ? (
                    <span className="policy-value-data">{displayLabel}</span>
                  ) : (
                    <code
                      className="policy-value-data"
                      data-type={
                        collection
                          ? 'empty'
                          : value === null
                            ? 'null'
                            : typeof value
                      }
                    >
                      {label}
                    </code>
                  )}
                  {help}
                </span>
                {description && !descriptionIsLabel ? (
                  <span className="policy-expression-caption">
                    {description.text}
                  </span>
                ) : null}
                {operands}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PolicyValueSection({
  title,
  value,
  location,
  itemSourceLocation,
  actions,
  headingRef,
}: {
  title: string;
  value: JsonValue | undefined;
  location?: string;
  itemSourceLocation?: string;
  actions?: PolicyDeclarationActions;
  headingRef?: React.Ref<HTMLHeadingElement>;
}): React.JSX.Element {
  return (
    <section className="policy-detail-section">
      <h4
        ref={headingRef}
        className={headingRef ? 'policy-binding-heading' : undefined}
        tabIndex={headingRef ? -1 : undefined}
      >
        {title}
      </h4>
      {value === undefined || value === null ? (
        <p className="policy-detail-empty">
          Not available in the saved definition
        </p>
      ) : (
        <PolicyValueList
          value={value}
          location={location}
          itemSourceLocation={itemSourceLocation}
          actions={actions}
        />
      )}
    </section>
  );
}

function PolicyDetails({
  id,
  model,
  node,
  view,
  childSteps,
  canShowExpression,
  describeExpression,
  onShowStep,
  onShowExpression,
  onClose,
}: {
  id: string;
  model: PolicyStructureModel;
  node: StructureStep | StructureDataNode | undefined;
  view: View;
  childSteps: ReadonlyMap<string, readonly StructureStep[]> | undefined;
  canShowExpression: (location: string, value: string) => boolean;
  describeExpression: DescribeExpression;
  onShowStep: (id: string) => void;
  onShowExpression: (location: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const bindingHeading = useRef<HTMLHeadingElement>(null);
  const detail = node
    ? model.details.find((detail) => detail.id === node.detailId)
    : undefined;
  const step =
    node &&
    ('type' in node
      ? node
      : model.steps.find((step) => step.id === node.stepId));
  let savedConfiguration = detail?.configuration;
  if (
    step?.type === 'reflection' &&
    savedConfiguration &&
    typeof savedConfiguration === 'object' &&
    !Array.isArray(savedConfiguration)
  ) {
    const { evidence, targets, ...rest } = savedConfiguration;
    savedConfiguration = {
      ...(evidence === undefined ? {} : { evidence }),
      ...(targets === undefined ? {} : { targets }),
      ...rest,
    };
  }
  const dataNode = node && 'kind' in node ? node : undefined;
  const dataKind = dataNode?.kind;
  const appearance = step
    ? stepAppearance[step.type]
    : dataKind && dataAppearance[dataKind];
  const declarationLocation =
    step?.location ??
    (dataKind === 'input' || dataKind === 'output' || dataKind === 'state'
      ? `/${dataKind}`
      : undefined);
  const itemScope =
    dataNode?.kind === 'item'
      ? model.scopes.find((scope) => scope.id === dataNode.scopeId)
      : undefined;
  const itemOwner = itemScope?.parentStepId
    ? model.steps.find((step) => step.id === itemScope.parentStepId)
    : undefined;
  const itemSourceLocation =
    itemOwner?.type === 'foreach' ? `${itemOwner.location}/foreach` : undefined;
  const configNode = !step
    ? model.data.nodes.find((node) => node.kind === 'config')
    : undefined;
  const isPluginCall = step?.type === 'invoke';
  const binding =
    isPluginCall && detail?.bindingId
      ? model.bindings.find((binding) => binding.id === detail.bindingId)
      : undefined;
  function showBinding(): void {
    const content = contentRef.current;
    const heading = bindingHeading.current;
    if (!content || !heading) return;
    content.scrollTop +=
      heading.getBoundingClientRect().top - content.getBoundingClientRect().top;
    heading.focus({ preventScroll: true });
  }
  const actions: PolicyDeclarationActions = {
    step,
    detail,
    rootConfig: step
      ? undefined
      : (model.details.find((detail) => detail.id === configNode?.detailId)
          ?.configuration ?? null),
    view,
    childSteps,
    canShowExpression,
    describeExpression,
    onShowStep,
    onShowExpression,
    onShowBinding: binding ? showBinding : undefined,
  };
  return (
    <aside
      id={id}
      className="policy-details"
      data-type={step?.type ?? dataKind}
      aria-label="Policy node details"
    >
      {node ? (
        <>
          <header>
            <div>
              {appearance ? <PolicyNodeKind appearance={appearance} /> : null}
              <h3>{'type' in node ? node.label : dataNodeLabel(node)}</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close node details"
            >
              ×
            </button>
          </header>
          <div
            className="policy-details-content"
            key={node.id}
            ref={contentRef}
          >
            <dl className="policy-detail-facts">
              <dt>Policy ID</dt>
              <dd>
                <code>{model.source.policyId ?? 'Unavailable'}</code>
              </dd>
              <dt>Digest</dt>
              <dd>
                <code>{model.source.definitionDigest ?? 'Unavailable'}</code>
              </dd>
            </dl>
            {model.diagnostics
              .filter(
                (diagnostic) =>
                  diagnostic.nodeId === node.id ||
                  (diagnostic.nodeId === null &&
                    (diagnostic.view === 'all' ||
                      diagnostic.view === 'details')),
              )
              .map((diagnostic, index) => (
                <p key={index} className="policy-detail-warning">
                  {diagnostic.message}
                </p>
              ))}
            <PolicyValueSection
              title="Declared fields and expressions"
              value={detail?.declaration}
              location={declarationLocation}
              itemSourceLocation={itemSourceLocation}
              actions={actions}
            />
            <PolicyValueSection
              title="Saved configuration context"
              value={savedConfiguration}
              location={
                dataKind === 'input' ? '/recipe/policy/input' : undefined
              }
              actions={dataKind === 'input' ? actions : undefined}
            />
            {binding ? (
              <PolicyValueSection
                title="Saved effective binding"
                headingRef={bindingHeading}
                value={{
                  Binding: binding.name,
                  Contract: binding.contract ?? 'Unavailable',
                  Plugin: binding.plugin ?? 'Unavailable',
                  Configuration: binding.configuration ?? 'Unavailable',
                }}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="policy-details-empty">
          <h3>Inspect a node</h3>
          <p>
            Select a step or data group to see its declaration and saved
            configuration.
          </p>
          <p>Use the separate + / − button to expand a container.</p>
        </div>
      )}
    </aside>
  );
}
