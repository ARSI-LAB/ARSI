import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callLabels,
  ownerCallId,
} from '../../web/features/experiments/call-labels.js';
import type { CallSummary } from '../../src/contracts/observation.js';
const call = (
  callId: string,
  pluginId: string,
  parentCallId: string | null,
  path: string,
): CallSummary => ({
  callId,
  pluginId,
  parentCallId,
  path,
  bindingId: 'binding',
  status: 'succeeded',
  startedAt: null,
  finishedAt: null,
  error: null,
});
test('agent calls retain business ownership through nested agents without confusing missing or cyclic parents', () => {
  for (const component of ['memory', 'proposer', 'reflection']) {
    const parent = call(
      'parent',
      `${component}.agent`,
      'root',
      'loop/0/remember',
    );
    const agent = call('agent', 'agent.pi', 'parent', 'call-parent');
    const nested = call('nested', 'agent.pi', 'agent', 'call-agent');
    const labels = callLabels(nested, [parent, agent, nested]);
    assert.equal(
      labels.title,
      `${component[0]!.toUpperCase()}${component.slice(1)} · Round 1`,
    );
    assert.equal(labels.plugins, `${component}.agent → agent.pi`);
    assert.equal(labels.path, 'loop/0/remember');
    assert.equal(ownerCallId(nested, [parent, agent, nested]), 'parent');
  }
  const orphan = call('orphan', 'agent.pi', 'missing', 'call-missing');
  assert.equal(callLabels(orphan, [orphan]).title, 'Agent');
  assert.equal(callLabels(orphan, [orphan]).path, null);
  assert.equal(ownerCallId(orphan, [orphan]), 'orphan');
  const cycle = call('cycle', 'agent.pi', 'cycle', 'call-cycle');
  assert.equal(callLabels(cycle, [cycle]).title, 'Agent');
  assert.equal(ownerCallId(cycle, [cycle]), 'cycle');
});
