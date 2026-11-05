import { RoundLabels } from './round-labels';
import React, { lazy, Suspense } from 'react';
import { ChartBoundary } from '../../components/chart-boundary';
import { parseOverview } from '../../api/observation-client';
import { useRoute } from '../../app/use-route';
import { viewRoute } from '../../app/view-memory';
import { route } from '../../app/routing';
import {
  Feedback,
  Status,
  Timestamp,
} from '../../components/observation-feedback';
import { Recipe } from './recipe';
import { Results } from './results';
import { Calls } from './calls';
import { Candidates } from './candidates';
import { Measurements } from './measurements';
import { Overview } from './overview';
import { useObservation } from './use-observation';
const ScoreCharts = lazy(() =>
  import('./charts/metric-panel').then((module) => ({
    default: module.ScoreCharts,
  })),
);

const views = [
  'overview',
  'calls',
  'candidates',
  'measurements',
  'recipe',
  'results',
] as const;
export function Experiment({
  id,
  view,
  candidate,
  artifact,
  call,
  measurement,
  file,
  directory,
}: {
  id: string;
  view: string;
  candidate?: string;
  artifact?: string;
  call?: string;
  measurement?: string;
  file?: string;
  directory?: string;
}): React.JSX.Element {
  const navigation = useRoute();
  const result = useObservation(`/${encodeURIComponent(id)}`, parseOverview);
  const selected = views.find((item) => item === view) ?? 'overview';
  return (
    <RoundLabels id={id} finished={!!result.data?.finishedAt}>
      <div className="page-stack">
        <header className="page-heading">
          <div>
            <a className="text-link" href="#">
              ← Experiments
            </a>
            <h1>{result.data?.recipeId ?? id}</h1>
            {result.data?.recipeId && result.data.recipeId !== id ? (
              <p>
                <code>{id}</code>
              </p>
            ) : null}
            {selected === 'overview' && result.data ? (
              <p className="muted">
                Started <Timestamp value={result.data.startedAt} /> · Finished{' '}
                <Timestamp value={result.data.finishedAt} />
              </p>
            ) : null}
          </div>
          <div className="actions">
            {result.data ? <Status value={result.data.status} /> : null}
          </div>
        </header>
        <nav className="view-nav" aria-label="Experiment views">
          {views.map((item) => (
            <a
              key={item}
              href={
                selected === item
                  ? route(id, item, candidate, artifact, navigation)
                  : viewRoute(id, item)
              }
              aria-current={selected === item ? 'page' : undefined}
            >
              {item === 'calls'
                ? 'Call history'
                : item[0]!.toUpperCase() + item.slice(1)}
            </a>
          ))}
        </nav>
        <Feedback {...result} />
        {result.data ? (
          <>
            {selected === 'recipe' ? (
              <Recipe id={id} />
            ) : selected === 'results' ? (
              <Results id={id} />
            ) : selected === 'overview' ? (
              <>
                {result.data.error ? (
                  <p className="error-notice">{result.data.error}</p>
                ) : null}
                <Overview data={result.data}>
                  <ChartBoundary key={selected}>
                    <Suspense fallback={<p role="status">Loading charts…</p>}>
                      <ScoreCharts id={id} />
                    </Suspense>
                  </ChartBoundary>
                </Overview>
              </>
            ) : selected === 'calls' ? (
              <Calls id={id} call={call} />
            ) : selected === 'candidates' ? (
              <Candidates
                id={id}
                selected={candidate}
                artifact={artifact}
                file={file}
                directory={directory}
              />
            ) : (
              <>
                <Measurements
                  key={`${candidate ?? ''}:${measurement ?? ''}`}
                  id={id}
                  candidate={candidate}
                  measurement={measurement}
                />
              </>
            )}
          </>
        ) : null}
      </div>
    </RoundLabels>
  );
}
