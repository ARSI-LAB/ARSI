import { subscribeRetry } from '../../api/connection-state';
import { parseDetails, parseMeasurements } from '../../api/observation-client';
import { useAllObservations, useObservation } from './use-observation';
import { loadCandidateDiff } from './candidate-diff';
import { finalResults } from './final-results';
import { Feedback } from '../../components/observation-feedback';
import { scoreGroups, scorePoints } from './charts/metric-data';
import { scoreLabel } from './record-identifiers';
import { harnessStage } from './round-label-model';
import { useRoundLabels } from './round-labels';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CandidateSummary } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute } from '../../app/use-route';
import { candidateGraph, nodeWidth, nodeHeight } from './candidate-graph';

function FileChanges({
  id,
  parent,
  current,
}: {
  id: string;
  parent: string;
  current: string;
}): React.JSX.Element {
  const [summary, setSummary] = useState('…');
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeRetry(() => setRevision((value) => value + 1)), []);
  useEffect(() => {
    const controller = new AbortController();
    setSummary('…');
    loadCandidateDiff(id, parent, current, controller.signal).then(
      (diff) => {
        if (controller.signal.aborted) return;
        const known = diff.changes.filter(
          (item) => item.kind !== 'unavailable',
        ).length;
        const unknown = diff.changes.length - known;
        setSummary(
          unknown
            ? `${known} changed · ${unknown} unknown`
            : `${known} file${known === 1 ? '' : 's'} changed`,
        );
      },
      () => {
        if (!controller.signal.aborted) setSummary('Changes unavailable');
      },
    );
    return () => controller.abort();
  }, [id, parent, current, revision]);
  return <span className="graph-file-summary">{summary}</span>;
}

export function CandidateRelations({
  id,
  candidates,
  selected,
}: {
  id: string;
  candidates: CandidateSummary[];
  selected?: string;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const { search, offset } = useRoute();
  const measurements = useAllObservations(
    `/${encodeURIComponent(id)}/measurements`,
    parseMeasurements,
  );
  const details = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
  );
  const all = measurements.data?.items ?? [];
  const validation = all.filter((item) =>
    /Validation|Baseline evaluation/.test(labels.evaluation(item.ref)),
  );
  const records = validation.length ? validation : all;
  const availableGroups = scoreGroups(records);
  const primaryName = availableGroups.some((item) => item.name === 'meanReward')
    ? 'meanReward'
    : availableGroups.some((item) => item.name === 'score')
      ? 'score'
      : availableGroups[0]?.name;
  const groups = availableGroups.filter(
    (item) => item.name === primaryName || item.name === 'successRate',
  );
  const group =
    (labels.isHarness && selected
      ? groups.find((item) =>
          scorePoints(records, item, 'value', all).some(
            (point) => point.candidateRef === selected,
          ),
        )
      : undefined) ??
    groups.find((item) => item.name === 'meanReward') ??
    groups[0];
  const statistic = group?.statistics.includes('value')
    ? 'value'
    : (group?.statistics[0] ?? 'value');
  const scores = new Map(
    group
      ? scorePoints(records, group, statistic, all).map((point) => [
          point.candidateRef,
          point,
        ])
      : [],
  );

  const delivered = finalResults(
    details.data?.resultReferences ?? [],
    all,
  ).candidates;
  const candidateByRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );

  const graph = useMemo(
    () =>
      candidateGraph(
        [...candidates].sort((a, b) => {
          if (a.parentRef === null && b.parentRef !== null) return -1;
          if (b.parentRef === null && a.parentRef !== null) return 1;
          const aStage = harnessStage(a.originPath);
          const bStage = harnessStage(b.originPath);
          if (
            aStage &&
            bStage &&
            aStage.round === bStage.round &&
            aStage.variant !== bStage.variant
          ) {
            const order = ['Base', 'Invariant', 'Domain', 'Composed'];
            return (
              order.indexOf(aStage.variant) - order.indexOf(bStage.variant)
            );
          }
          return labels
            .candidate(a.ref)
            .localeCompare(labels.candidate(b.ref), undefined, {
              numeric: true,
            });
        }),
        selected,
      ),
    [candidates, selected, labels],
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
      <div className="section-heading graph-toolbar">
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
            Fit
          </button>
        </div>
      </div>
      <Feedback {...measurements} />
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
            {graph.nodes.map((node) => {
              const candidate = candidateByRef.get(node.ref);
              const parent = node.parentRef
                ? candidateByRef.get(node.parentRef)
                : undefined;
              const value = scores.get(node.ref)?.value;
              const parentValue = node.parentRef
                ? scores.get(node.parentRef)?.value
                : null;
              const delta =
                group?.comparable && value != null && parentValue != null
                  ? value - parentValue
                  : null;
              return node.missing ? (
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
                  title={
                    scores.get(node.ref)?.value == null
                      ? undefined
                      : scoreLabel(scores.get(node.ref)!.value!)
                  }
                >
                  <span className="graph-node-heading">
                    <strong className="graph-round">
                      {labels.candidate(node.ref)}
                    </strong>
                    {delivered.includes(node.ref) ? (
                      <span className="graph-final">
                        {labels.isHarness ? 'Delivered' : 'Final'}
                      </span>
                    ) : null}
                  </span>
                  <span className="graph-score-row">
                    <span className="graph-score">
                      {scores.get(node.ref)?.value == null
                        ? '—'
                        : scoreLabel(scores.get(node.ref)!.value!)}
                    </span>
                    {delta !== null ? (
                      <span
                        className="graph-delta"
                        title={`Change vs parent: ${scoreLabel(delta)}`}
                      >
                        {delta > 0 ? '+' : delta < 0 ? '−' : ''}
                        {scoreLabel(Math.abs(delta))}
                      </span>
                    ) : null}
                  </span>
                  {candidate && parent ? (
                    <FileChanges
                      key={candidate.artifactRef}
                      id={id}
                      parent={parent.artifactRef}
                      current={candidate.artifactRef}
                    />
                  ) : null}
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
