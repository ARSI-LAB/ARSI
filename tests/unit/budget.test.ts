import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContext,
  type FactStore,
  type JsonObject,
} from '../../src/contracts/index.js';
import { BudgetLedger } from '../../src/runtime/manager/budget.js';

test('a failed budget fact write does not consume a charge before a successful retry', async () => {
  let fail = true;
  let saved: JsonObject = {};
  const facts: FactStore = {
    async read() {
      return saved;
    },
    async list() {
      return [saved];
    },
    async write(_kind, _id, value) {
      if (fail) {
        fail = false;
        throw new Error('budget storage unavailable');
      }
      saved = structuredClone(value);
    },
  };
  const ledger = new BudgetLedger('test', facts, { operations: 1 }, () => {});
  const context = new RuntimeContext();
  await assert.rejects(
    ledger.charge('operations', 1, context),
    /storage unavailable/,
  );
  assert.deepEqual(ledger.usage, {});
  await ledger.charge('operations', 1, context);
  assert.equal(ledger.usage.operations, 1);
  assert.equal(saved.operations, 1);
});
