import React, { useCallback, useMemo, useState } from 'react';
import type { JsonValue } from '../../../src/contracts/json.js';
import type {
  PolicyStructure as PolicyStructureModel,
  StructureDataNode,
  StructureStep,
} from '../../../src/contracts/policy-structure.js';
import { parsePolicyStructure } from '../../api/observation-client';
import { Feedback } from '../../components/observation-feedback';
import { useObservation } from './use-observation';
import {
  dataHeaderHeight,
  dataPortHeight,
  focusedPolicyData,
  layoutPolicyData,
  layoutPolicyFlow,
  revealPolicyStep,
  type PolicyLayout,
} from './policy-layout';
import { PolicyViewport, type PolicyViewportState } from './policy-viewport';

type View = 'flow' | 'data';
function position(box: PolicyLayout['nodes'][number]): React.CSSProperties {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

function stepSubtitle(
  step: StructureStep,
  value: JsonValue | undefined,
): string {
  const declaration =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const display = (field: string, fallback = 'not declared'): string => {
    const value = declaration[field];
    return value === undefined
      ? fallback
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
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
  const [view, setView] = useState<View>('flow');
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [fullData, setFullData] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [viewports, setViewports] = useState<
    Record<View, PolicyViewportState | null>
  >({ flow: null, data: null });
  const [reveal, setReveal] = useState<{
    id: string;
    token: number;
    view: View;
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
  const visibleData = useMemo(
    () => focusedPolicyData(model, fullData ? null : focus),
    [model, fullData, focus],
  );
  const dataLayout = useMemo(
    () => layoutPolicyData(visibleData),
    [visibleData],
  );
  const layout = view === 'flow' ? flowLayout : dataLayout;
  const onViewport = useCallback(
    (next: PolicyViewportState) =>
      setViewports((previous) => ({ ...previous, [view]: next })),
    [view],
  );
  const selectedNode = selected
    ? view === 'flow'
      ? steps.get(selected)
      : dataNodes.get(selected)
    : undefined;
  const revealBox =
    reveal?.view === view
      ? layout.nodes.find((node) => node.id === reveal.id)
      : undefined;
  const revealTarget = useMemo(
    () =>
      reveal && revealBox ? { token: reveal.token, box: revealBox } : null,
    [reveal, revealBox],
  );

  function select(id: string): void {
    setSelected(id);
    if (steps.has(id)) setFocus(id);
  }
  function switchView(next: View): void {
    if (next === view) return;
    const step = selected ? steps.get(selected) : undefined;
    const corresponding = step && (next === 'flow' || dataNodes.has(step.id));
    if (corresponding && step) {
      if (next === 'flow')
        setExpanded((current) => revealPolicyStep(model, step.id, current));
      else {
        setFocus(step.id);
        setFullData(false);
      }
      setReveal((previous) => ({
        id: step.id,
        view: next,
        token: (previous?.token ?? 0) + 1,
      }));
    } else {
      setSelected(null);
      setReveal(null);
    }
    setView(next);
  }
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
        Declared structure and dependencies. Expressions are not evaluated;
        runtime values and execution outcomes are unknown.
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
              aria-pressed={!fullData && !!focus}
              disabled={!focus}
              onClick={() => setFullData(false)}
            >
              Focused
            </button>
            <button
              type="button"
              aria-pressed={fullData || !focus}
              onClick={() => setFullData(true)}
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
      {view === 'data' && !fullData && focus ? (
        <p className="policy-focus-caption">
          Direct relationships of{' '}
          <strong>{steps.get(focus)?.label ?? 'selected step'}</strong>.
          Selecting a data group keeps this extent.
        </p>
      ) : null}
      <div className="policy-workspace" data-has-selection={!!selectedNode}>
        {model.availability[view] === 'unavailable' ? (
          <div className="policy-empty">
            <h3>{view === 'flow' ? 'Flow' : 'Data'} view unavailable</h3>
            <p>
              The saved definition could not provide a reliable model for this
              view.
            </p>
          </div>
        ) : (view === 'flow'
            ? model.steps.length
            : visibleData.nodes.length) === 0 ? (
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
            <PolicyEdges layout={layout} selected={selected} view={view} />
            {layout.nodes.map((box) => {
              if (view === 'data') {
                const node = dataNodes.get(box.id)!;
                return (
                  <DataNode
                    key={box.id}
                    node={node}
                    box={box}
                    selected={selected === box.id}
                    onSelect={() => select(box.id)}
                  />
                );
              }
              const step = steps.get(box.id);
              if (!step) {
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
              const subtitle = stepSubtitle(step, detail?.declaration);
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
                    onClick={() => select(step.id)}
                    aria-pressed={selected === step.id}
                    title={`${step.label}\n${step.location}`}
                  >
                    <span className="policy-node-kind">{step.type}</span>
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
        <PolicyDetails
          model={model}
          node={selectedNode}
          onClose={() => setSelected(null)}
        />
      </div>
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
}: {
  layout: PolicyLayout;
  selected: string | null;
  view: View;
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
          data-active={edge.sourceId === selected || edge.targetId === selected}
          data-dynamic={edge.dynamic}
          data-kind={edge.kind}
        >
          <title>{edge.label || edge.kind}</title>
          <path d={edge.path} markerEnd={`url(#policy-arrow-${view})`} />
          {edge.label ? (
            <text x={edge.labelX} y={edge.labelY}>
              {edge.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function DataNode({
  node,
  box,
  selected,
  onSelect,
}: {
  node: StructureDataNode;
  box: PolicyLayout['nodes'][number];
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <section
      className="policy-data-node"
      data-selected={selected}
      style={position(box)}
      aria-label={node.label}
    >
      <button
        type="button"
        className="policy-node-select"
        style={{ height: dataHeaderHeight }}
        onClick={onSelect}
        aria-pressed={selected}
        title={node.label}
      >
        <span className="policy-node-kind">{node.kind}</span>
        <strong>{node.label}</strong>
      </button>
      <div className="policy-ports">
        {node.ports.length ? (
          node.ports.map((port) => (
            <div
              key={port.id}
              className="policy-port"
              data-role={port.role}
              style={{ height: dataPortHeight }}
              title={`${port.label}\n${port.location}`}
            >
              <span className="policy-port-dot" />
              <code>{port.label}</code>
              <span className="policy-port-dot" />
            </div>
          ))
        ) : (
          <div className="policy-no-ports">No referenced fields</div>
        )}
      </div>
    </section>
  );
}

function JsonSection({
  title,
  value,
}: {
  title: string;
  value: JsonValue | undefined;
}): React.JSX.Element {
  return (
    <section className="policy-detail-section">
      <h4>{title}</h4>
      <pre tabIndex={0}>
        {value === undefined || value === null
          ? 'Not available in the saved definition'
          : JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

function PolicyDetails({
  model,
  node,
  onClose,
}: {
  model: PolicyStructureModel;
  node: StructureStep | StructureDataNode | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const detail = node
    ? model.details.find((detail) => detail.id === node.detailId)
    : undefined;
  const binding = detail?.bindingId
    ? model.bindings.find((binding) => binding.id === detail.bindingId)
    : undefined;
  const dataNode = node
    ? model.data.nodes.find((data) => data.id === node.id)
    : undefined;
  const scope = node
    ? model.scopes.find((scope) => scope.id === node.scopeId)
    : undefined;
  const relationships = node
    ? model.data.edges.filter(
        (edge) =>
          edge.source.nodeId === node.id || edge.target.nodeId === node.id,
      )
    : [];
  const dataById = new Map(model.data.nodes.map((node) => [node.id, node]));
  const flowById = new Map(model.flow.nodes.map((node) => [node.id, node]));
  const flowRelationships = node
    ? model.flow.edges.filter(
        (edge) =>
          flowById.get(edge.source)?.stepId === node.id ||
          flowById.get(edge.target)?.stepId === node.id,
      )
    : [];
  function endpointLabel(endpoint: { nodeId: string; portId: string }): string {
    const group = dataById.get(endpoint.nodeId);
    return `${group?.label ?? endpoint.nodeId} · ${group?.ports.find((port) => port.id === endpoint.portId)?.label ?? endpoint.portId}`;
  }
  return (
    <aside className="policy-details" aria-label="Policy node details">
      {node ? (
        <>
          <header>
            <div>
              <span className="policy-node-kind">
                {'type' in node ? node.type : node.kind}
              </span>
              <h3>{node.label}</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close node details"
            >
              ×
            </button>
          </header>
          <div className="policy-details-content">
            <dl className="policy-detail-facts">
              <dt>Node ID</dt>
              <dd>
                <code>{node.id}</code>
              </dd>
              <dt>Scope</dt>
              <dd>
                <code>{scope?.location ?? node.scopeId}</code>
              </dd>
              <dt>Declaration</dt>
              <dd>
                <code>
                  {'location' in node ? node.location : 'Source group'}
                </code>
              </dd>
              <dt>Snapshot</dt>
              <dd>Initial saved definition</dd>
              <dt>Policy</dt>
              <dd>{model.source.policyId}</dd>
              <dt>Digest</dt>
              <dd>
                <code>{model.source.definitionDigest}</code>
              </dd>
            </dl>
            {model.diagnostics
              .filter(
                (diagnostic) =>
                  diagnostic.nodeId === node.id ||
                  diagnostic.view === 'all' ||
                  diagnostic.view === 'details',
              )
              .map((diagnostic, index) => (
                <p key={index} className="policy-detail-warning">
                  {diagnostic.message}
                  {diagnostic.location ? ` (${diagnostic.location})` : ''}
                </p>
              ))}
            {binding ? (
              <section className="policy-detail-section">
                <h4>Saved effective binding</h4>
                <dl className="policy-detail-facts">
                  <dt>Binding</dt>
                  <dd>{binding.name}</dd>
                  <dt>Contract</dt>
                  <dd>{binding.contract ?? 'Unavailable'}</dd>
                  <dt>Plugin</dt>
                  <dd>{binding.plugin ?? 'Unavailable'}</dd>
                </dl>
                <JsonSection
                  title="Saved plugin configuration"
                  value={binding.configuration}
                />
              </section>
            ) : null}
            <JsonSection
              title="Declared fields and expressions"
              value={detail?.declaration}
            />
            <JsonSection
              title="Saved configuration context"
              value={detail?.configuration}
            />
            {dataNode?.ports.length ? (
              <section className="policy-detail-section">
                <h4>Referenced fields and expression locations</h4>
                <ul>
                  {dataNode.ports.map((port) => (
                    <li key={port.id}>
                      <code>{port.label}</code>
                      <small>
                        {port.role} · {port.location}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {flowRelationships.length ? (
              <section className="policy-detail-section">
                <h4>Declared control relationships</h4>
                <ul>
                  {flowRelationships.map((edge) => (
                    <li key={edge.id}>
                      <span>
                        {flowById.get(edge.source)?.label} →{' '}
                        {flowById.get(edge.target)?.label}
                      </span>
                      <small>
                        {edge.kind}
                        {edge.label ? ` · ${edge.label}` : ''}
                      </small>
                      <code>{edge.location}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="policy-detail-section">
              <h4>Connected data relationships ({relationships.length})</h4>
              {relationships.length ? (
                <ul>
                  {relationships.map((edge) => (
                    <li key={edge.id}>
                      <span>
                        {endpointLabel(edge.source)} →{' '}
                        {endpointLabel(edge.target)}
                      </span>
                      <small>
                        {edge.kind}
                        {edge.dynamic ? ' · dynamic access' : ''}
                        {edge.label ? ` · ${edge.label}` : ''}
                      </small>
                      <code>{edge.location}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No declared data relationships for this node.</p>
              )}
            </section>
          </div>
        </>
      ) : (
        <div className="policy-details-empty">
          <h3>Inspect a node</h3>
          <p>
            Select a step or data group to see its declaration, scope, and saved
            configuration.
          </p>
          <p>Use the separate + / − button to expand a container.</p>
        </div>
      )}
    </aside>
  );
}
