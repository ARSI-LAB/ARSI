import type { CallSummary } from '../../api/observation-client.js';
import { roundLabel, type HarnessStage } from './round-label-model.js';

export function callLabels(
  call: CallSummary,
  calls: readonly CallSummary[],
  stages: ReadonlyMap<string, HarnessStage> = new Map(),
  byId: ReadonlyMap<string, CallSummary> = new Map(
    calls.map((item) => [item.callId, item]),
  ),
): {
  title: string;
  round: string | null;
  plugins: string;
  path: string | null;
  parent: string | null;
} {
  let owner = call;
  const seen = new Set<string>();
  while (
    owner.pluginId.startsWith('agent.') &&
    owner.parentCallId &&
    !seen.has(owner.callId)
  ) {
    seen.add(owner.callId);
    const parent = byId.get(owner.parentCallId);
    if (!parent) break;
    owner = parent;
  }
  const names: Record<string, string> = {
    memory: 'Memory',
    reflection: 'Reflection',
    proposer: 'Proposer',
    selector: 'Selector',
    evaluator: 'Evaluator',
    application: 'Application',
    agent: 'Agent',
  };
  const roles: Record<string, string> = {
    invariantProposer: 'Inv Proposer',
    domainProposer: 'Domain Proposer',
    composer: 'Composer',
  };
  let component = owner.pluginId.startsWith('proposer.')
    ? (roles[owner.bindingId] ??
      (owner.bindingId === 'proposer' ? 'Proposer' : owner.bindingId))
    : (names[owner.pluginId.split('.')[0]!] ?? owner.bindingId);
  const stage = stages.get(owner.callId);
  if (owner.pluginId.startsWith('evaluator.') && stage)
    component += ` · ${stage.variant === 'Invariant' ? 'Inv' : stage.variant}`;

  const path =
    owner.path && !owner.path.startsWith('call-') ? owner.path : null;
  const round = stage?.round ?? roundLabel(owner.triggerPath ?? path);
  return {
    title: component,
    round: round?.replace(/Round /g, 'R') ?? null,
    plugins:
      owner.callId === call.callId
        ? call.pluginId
        : `${owner.pluginId} → ${call.pluginId}`,
    path,
    parent: call.parentCallId
      ? (byId.get(call.parentCallId)?.pluginId ?? null)
      : null,
  };
}

/** Find the business component owning an agent, including nested agent executions. */
export function ownerCallId(
  call: CallSummary,
  calls: readonly CallSummary[],
): string {
  let current = call;
  const seen = new Set<string>();
  while (
    current.pluginId.startsWith('agent.') &&
    current.parentCallId &&
    !seen.has(current.callId)
  ) {
    seen.add(current.callId);
    const parent = calls.find((item) => item.callId === current.parentCallId);
    if (!parent) break;
    current = parent;
  }
  return current.callId;
}
