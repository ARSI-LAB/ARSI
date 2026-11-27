import test from 'node:test';
import assert from 'node:assert/strict';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';
import { object } from '../../src/shared/json.js';

test('Manager evidence uses explicit views and byte limits rather than plugin configuration', async () => {
  const fixture = await managerFixture(
    async (context) => {
      const measurement = await measurementFixture(context);
      const ref = await context.recordMeasurement(measurement);
      const execution = await context.readEvidence([ref]);
      assert.equal(object(execution).view, 'execution');
      assert.doesNotMatch(JSON.stringify(execution), /"metrics"/);
      assert.ok(Buffer.byteLength(JSON.stringify(execution)) > 1024);
      const training = await context.readEvidence([ref], {
        view: 'training-summary',
      });
      assert.match(JSON.stringify(training), /"score"/);
      for (const format of [undefined, 'files'] as const) {
        const projection = object(
          await context.readEvidence([ref], { view: 'training', format }),
        );
        assert.equal(projection.view, 'training');
        assert.ok(Array.isArray(projection.measurements));
        assert.deepEqual(
          object(projection.measurements[0]).metrics,
          measurement.metrics,
        );
        if (format === 'files')
          assert.match(JSON.stringify(projection.files), /execution trace/);
      }
      const bounded = await context.readEvidence([ref], {
        view: 'execution',
        maxBytes: 1024,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1024);
      const scoped = await context
        .extend({
          scope: {
            id: 'evidence-test',
            signal: context.signal,
            limits: { modelCalls: 1, elapsedWallMs: 1000, evidenceBytes: 512 },
          },
        })
        .readEvidence([ref], { view: 'execution', maxBytes: 4096 });
      assert.ok(Buffer.byteLength(JSON.stringify(scoped)) <= 512);
      await assert.rejects(
        context.readEvidence([ref], {
          format: 'files',
          view: 'execution',
          maxBytes: 512,
        }),
        /byte limit/,
      );
      const files = await context.readEvidence([ref], {
        format: 'files',
      });
      assert.equal(object(files).schemaVersion, 'rsi.evidence-files/v1');
      assert.equal(object(files).view, 'execution');
      assert.doesNotMatch(JSON.stringify(files), /"metrics"/);
      return {};
    },
    { config: { evidenceView: 'training-summary' } },
  );
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

test('Evidence summaries count toward structured and file output byte limits', async () => {
  const fixture = await managerFixture(async (context) => {
    await context.facts.write('evidence-views', 'evidence-summary', {
      experimentId: context.experimentId,
      measurementRefs: [],
      summary: { text: 's'.repeat(2048) },
    });
    const refs = ['evidence-summary'];
    const structured = await context.readEvidence(refs, {
      maxBytes: 256,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(structured)) <= 256);
    assert.equal(object(structured).truncated, true);
    await assert.rejects(
      context.readEvidence(refs, {
        format: 'files',
        maxBytes: 1024,
      }),
      /Full evidence context exceeds byte limit/,
    );
    const files = await context.readEvidence(refs, {
      format: 'files',
      maxBytes: 4096,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(files)) <= 4096);
    assert.ok(Array.isArray(object(files).summaries));
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

test('Explicit JSON evidence budgets above the summary default remain usable and respect scope limits', async () => {
  const fixture = await managerFixture(async (context) => {
    await context.facts.write('evidence-views', 'evidence-large-summary', {
      experimentId: context.experimentId,
      measurementRefs: [],
      summary: { text: 's'.repeat(100000) + 'SUMMARY_END' },
    });
    const refs = ['evidence-large-summary'];
    const expanded = await context.readEvidence(refs, { maxBytes: 200000 });
    assert.match(JSON.stringify(expanded), /SUMMARY_END/);
    const scoped = await context
      .extend({
        scope: {
          id: 'bounded-summary',
          signal: context.signal,
          limits: { evidenceBytes: 1000 },
        },
      })
      .readEvidence(refs, { maxBytes: 200000 });
    assert.doesNotMatch(JSON.stringify(scoped), /SUMMARY_END/);
    assert.ok(Buffer.byteLength(JSON.stringify(scoped)) <= 1000);
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

test('evidence wrapper summaries supply sanitized execution context and stay out of delivery', async () => {
  const fixture = await managerFixture(async (context) => {
    const refs = ['evidence-wrapped'];
    await context.facts.write('evidence-views', refs[0], {
      experimentId: context.experimentId,
      measurementRefs: [],
      summary: {
        note: 'ordinary context',
        evaluation: { checks: [{ message: 'withheld hint' }] },
      },
    });
    for (const format of [undefined, 'files'] as const) {
      const evidence = await context.readEvidence(refs, { format });
      assert.match(JSON.stringify(evidence), /ordinary context/);
      assert.doesNotMatch(JSON.stringify(evidence), /withheld hint/);
    }
    const delivery = await context.readEvidence(refs, { view: 'delivery' });
    assert.doesNotMatch(
      JSON.stringify(delivery),
      /ordinary context|withheld hint/,
    );
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

test('Manager rejects invalid explicit evidence limits before reading resources', async () => {
  const fixture = await managerFixture(async (context) => {
    for (const maxBytes of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assert.rejects(
        context.readEvidence([], { view: 'execution', maxBytes }),
        /readEvidence.maxBytes/,
      );
    }
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});

test('Explicit evidence options preserve Measurement experiment ownership', async () => {
  const fixture = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    await context.recordMeasurement(measurement);
    const ref = 'measurement-foreign';
    await context.facts.write('measurements', ref, {
      ...measurement,
      ref,
      experimentId: 'another-experiment',
    });
    for (const view of [
      'execution',
      'training',
      'training-summary',
      'delivery',
    ] as const) {
      await assert.rejects(
        context.readEvidence([ref], { view, maxBytes: 4096 }),
        /another experiment/,
      );
    }
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});
