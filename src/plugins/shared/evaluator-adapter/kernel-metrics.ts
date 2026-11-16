/**
 * Canonical operator metric catalogue shared by operator evaluators.
 *
 * Measurement mechanics (scope timings, error distribution, launch counts) are
 * owned by ember-evaluator; this catalogue only names the evidence and records
 * how it is mapped, so selectors and proposers can validate metric ids without
 * duplicating evaluator internals.
 */
export type KernelMetricDescriptor = {
  readonly id: string;
  readonly unit: string;
  readonly mapping: string;
  readonly aggregation: string;
};

export const KERNEL_METRIC_CATALOG: readonly KernelMetricDescriptor[] = [
  {
    id: 'candidateValid',
    unit: 'boolean',
    mapping: 'kernel-v1 assessment.checks',
    aggregation: 'all strict checks passed',
  },
  {
    id: 'latencyMeanMs',
    unit: 'ms',
    mapping: 'kernel-v1 timing.device.meanMs',
    aggregation: 'mean of measured device iterations',
  },
  {
    id: 'referenceMeanMs',
    unit: 'ms',
    mapping: 'kernel-v1 referenceMs',
    aggregation: 'mean of measured reference iterations',
  },
  {
    id: 'speedupVsReference',
    unit: 'ratio',
    mapping: 'kernel-v1 speedup',
    aggregation: 'reference mean divided by candidate mean',
  },
  {
    id: 'hostMeanMs',
    unit: 'ms',
    mapping: 'kernel-v1 timing.host.meanMs',
    aggregation: 'mean of measured host launches',
  },
  {
    id: 'endToEndP50Ms',
    unit: 'ms',
    mapping: 'kernel-v1 timing.endToEnd.p50Ms',
    aggregation: 'median of measured end-to-end iterations',
  },
  {
    id: 'wholeNetP50Ms',
    unit: 'ms',
    mapping: 'evaluator.ascend-whole-net wholeNetP50Ms',
    aggregation: 'median of alternating candidate on/off runs',
  },
  {
    id: 'wholeNetP95Ms',
    unit: 'ms',
    mapping: 'evaluator.ascend-whole-net wholeNetP95Ms',
    aggregation: 'p95 of alternating candidate on/off runs',
  },
  {
    id: 'wholeNetOffP50Ms',
    unit: 'ms',
    mapping: 'evaluator.ascend-whole-net wholeNetOffP50Ms',
    aggregation: 'median of candidate-off runs in the same session',
  },
  {
    id: 'wholeNetDeltaPct',
    unit: 'percent',
    mapping: 'evaluator.ascend-whole-net wholeNetDeltaPct',
    aggregation: 'candidate-on versus candidate-off P50 difference',
  },
  {
    id: 'launchCount',
    unit: 'count',
    mapping: 'kernel-v1 timing.launchCount',
    aggregation: 'launches per forward pass',
  },
  {
    id: 'referenceErrorMaxAbs',
    unit: 'abs',
    mapping: 'kernel-v1 errorStats.maxAbs',
    aggregation: 'maximum absolute error against the reference',
  },
];

export const KERNEL_METRIC_IDS: readonly string[] = KERNEL_METRIC_CATALOG.map(
  (metric) => metric.id,
);

export function kernelMetricDescriptor(id: string): KernelMetricDescriptor {
  const descriptor = KERNEL_METRIC_CATALOG.find((metric) => metric.id === id);
  if (descriptor === undefined)
    throw new Error(`Unknown operator kernel metric ${id}`);
  return descriptor;
}
