import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CandidateSummary } from '../../api/observation-client';
import { candidateLabel } from './record-identifiers';
import { route } from '../../app/routing';
import { useRoute } from '../../app/use-route';
import { candidateGraph, nodeWidth, nodeHeight } from './candidate-graph';

export function CandidateRelations({
  id,
  candidates,
  selected,
}: {
  id: string;
  candidates: CandidateSummary[];
  selected?: string;
}): React.JSX.Element {
  const { search, offset } = useRoute();
  const graph = useMemo(
    () => candidateGraph(candidates, selected),
    [candidates, selected],
  );
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  const fitGraph = (): void => {
    const element = viewport.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const width =
      element.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    setZoom(Math.max(0.25, Math.min(1, width / graph.width)));
  };
  const nodes = new Map(graph.nodes.map((node) => [node.ref, node]));
  return (
    <section
      className="candidate-graph-panel"
      aria-label="Candidate relationship graph"
    >
      <div className="section-heading">
        <div>
          <h3>Recorded relationships</h3>
          <p>
            {graph.shown} of {graph.total} candidates shown. Arrows follow
            recorded parent references.
          </p>
        </div>
        <div className="actions" aria-label="Graph zoom controls">
          <button
            className="quiet-button"
            aria-label="Zoom out candidate graph"
            disabled={zoom <= 0.25}
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="quiet-button"
            aria-label="Zoom in candidate graph"
            disabled={zoom >= 1.5}
            onClick={() => setZoom((value) => Math.min(1.5, value + 0.25))}
          >
            +
          </button>
          <button className="quiet-button" onClick={fitGraph}>
            Fit graph
          </button>
        </div>
      </div>
      {graph.cyclic ? (
        <p className="error-notice" role="status">
          A cycle is present in the recorded parent links. The diagram preserves
          those links without assigning an ancestry order to the cycle.
        </p>
      ) : null}
      {graph.shown < graph.total ? (
        <p className="filter-note">
          The graph is limited to 150 candidates and includes the selected
          candidate. Use the searchable records below for the complete loaded
          collection.
        </p>
      ) : null}
      <div
        className="candidate-graph-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Scrollable candidate graph; each candidate is a link"
      >
        <div style={{ width: graph.width * zoom, height: graph.height * zoom }}>
          <div
            className="candidate-graph-canvas"
            style={{
              width: graph.width,
              height: graph.height,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              width={graph.width}
              height={graph.height}
              aria-hidden="true"
              className="candidate-edges"
            >
              <defs>
                <marker
                  id="candidate-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const from = nodes.get(edge.source),
                  to = nodes.get(edge.target);
                if (!from || !to) return null;
                const x = from.x + nodeWidth,
                  y = from.y + nodeHeight / 2;
                const endX = to.x,
                  endY = to.y + nodeHeight / 2;
                const bend = Math.max(32, Math.abs(endX - x) / 2);
                return (
                  <path
                    key={edge.target}
                    className="candidate-connector"
                    data-selected={
                      edge.target === selected || edge.source === selected
                    }
                    d={`M${x},${y} C${x + bend},${y} ${endX - bend},${endY} ${endX},${endY}`}
                    markerEnd="url(#candidate-arrow)"
                  />
                );
              })}
            </svg>
            {graph.nodes.map((node) =>
              node.missing ? (
                <div
                  key={node.ref}
                  className="graph-node graph-node-missing"
                  style={{ left: node.x, top: node.y }}
                >
                  <span>
                    {node.outside
                      ? 'Parent outside displayed graph'
                      : 'Parent record unavailable'}
                  </span>
                  <code title={node.ref}>{node.ref}</code>
                </div>
              ) : (
                <a
                  key={node.ref}
                  ref={node.ref === selected ? focused : undefined}
                  className="graph-node"
                  style={{ left: node.x, top: node.y }}
                  href={route(id, 'candidates', node.ref, undefined, {
                    search,
                    offset,
                  })}
                  aria-current={node.ref === selected ? 'true' : undefined}
                  aria-label={`Inspect candidate ${candidateLabel(node.ref)} (${node.ref})`}
                  title={node.ref}
                >
                  <span>
                    <strong>{candidateLabel(node.ref)}</strong> ·{' '}
                    {node.ref === selected
                      ? 'Selected candidate'
                      : node.parentRef
                        ? 'Candidate'
                        : 'No parent recorded'}
                  </span>
                  <code>{node.ref}</code>
                  <small>Inspect candidate →</small>
                </a>
              ),
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
