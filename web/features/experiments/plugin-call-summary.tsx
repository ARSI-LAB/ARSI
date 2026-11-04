import React from 'react';
import type {
  CallDetail,
  MeasurementSummary,
} from '../../api/observation-client';
import { route } from '../../app/routing';
import { Status } from '../../components/observation-feedback';
import { useRoundLabels } from './round-labels';
import { scoreLabel } from './record-identifiers';
import { eventObject } from './trace-model';

export function previewObject(
  preview: CallDetail['output'] | undefined,
): Record<string, unknown> {
  if (!preview || preview.truncated) return {};
  try {
    return eventObject(JSON.parse(preview.text));
  } catch {
    return {};
  }
}
export function PluginCallSummary({
  id,
  plugin,
  detail,
  measurements,
}: {
  id: string;
  plugin: string;
  detail: CallDetail | undefined;
  measurements: MeasurementSummary[];
}): React.JSX.Element | null {
  const labels = useRoundLabels();
  const output = previewObject(detail?.output),
    input = previewObject(detail?.input);
  const candidate =
    output.selectedCandidateRef ??
    output.candidateRef ??
    output.initialCandidateRef ??
    input.candidateRef;
  const candidateLabel =
    typeof candidate === 'string' ? (
      <span>{labels.candidate(candidate)}</span>
    ) : null;
  if (plugin.startsWith('evaluator.'))
    return (
      <section className="plugin-summary">
        <h4>Evaluations</h4>
        {measurements.length ? (
          measurements.map((m) => {
            const score =
              m.metrics.find((x) => x.name === 'meanReward') ??
              m.metrics.find((x) => x.name === 'score') ??
              m.metrics.find((x) => x.name === 'reward.reward');
            return (
              <div key={m.ref} className="evaluation-summary">
                <div>
                  <a
                    className="text-link"
                    href={route(id, 'measurements', undefined, undefined, {
                      measurement: m.ref,
                    })}
                  >
                    {labels.evaluation(m.ref)} →
                  </a>
                  <Status value={m.status} />
                </div>
                <span>{labels.candidate(m.candidateRef)}</span>
                {score ? (
                  <div>
                    {score.name === 'meanReward' ? 'Average score' : 'Score'} ·{' '}
                    {Object.values(score.values)
                      .filter((v): v is number => typeof v === 'number')
                      .map(scoreLabel)
                      .join(' / ') || 'Not available'}
                  </div>
                ) : null}
                <small className="muted">{m.coverage}</small>
              </div>
            );
          })
        ) : (
          <p className="muted">No evaluation results recorded yet.</p>
        )}
      </section>
    );
  if (plugin.startsWith('selector.'))
    return (
      <section className="plugin-summary">
        <h4>Selection</h4>
        <dl className="facts">
          <dt>Selected</dt>
          <dd>{candidateLabel ?? 'Not recorded'}</dd>
          {typeof output.accepted === 'boolean' ? (
            <>
              <dt>Decision</dt>
              <dd>{output.accepted ? 'Accepted' : 'Kept incumbent'}</dd>
            </>
          ) : null}
          {typeof output.selectedValue === 'number' ? (
            <>
              <dt>Score</dt>
              <dd>{scoreLabel(output.selectedValue)}</dd>
            </>
          ) : null}
        </dl>
        {typeof output.reason === 'string' ? <p>{output.reason}</p> : null}
      </section>
    );
  if (plugin.startsWith('application.'))
    return (
      <section className="plugin-summary">
        <h4>Application</h4>
        <dl className="facts">
          <dt>Operation</dt>
          <dd>
            {typeof output.action === 'string'
              ? output.action
              : typeof input.action === 'string'
                ? input.action
                : 'Not recorded'}
          </dd>
          {candidateLabel ? (
            <>
              <dt>Version</dt>
              <dd>{candidateLabel}</dd>
            </>
          ) : null}
          {typeof output.status === 'string' ? (
            <>
              <dt>Result</dt>
              <dd>{output.status}</dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  return null;
}
