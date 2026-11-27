import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { codexExecutable, command, modelEnvironment } from './process.mjs';

const require = createRequire(resolve(process.argv[1]));
const Ajv = require('ajv');

export function validateResult(result, schema, anchors, threads) {
  const validate = new Ajv().compile(schema);
  if (!validate(result))
    throw new Error(
      'Invalid Codex findings schema: ' + validate.errors[0].instancePath,
    );
  const ids = new Set();
  for (const f of result.findings) {
    if (ids.has(f.finding_id)) throw new Error('Duplicate finding identifier');
    ids.add(f.finding_id);
    if (
      !anchors
        .get(f.file)
        ?.[f.side].some(([first, last]) => f.line >= first && f.line <= last)
    ) {
      throw new Error('Finding outside the PR diff');
    }
    for (const value of [
      f.problem,
      f.impact,
      f.recommendation,
      f.evidence,
      f.remediation,
      f.acceptance,
    ]) {
      if (!value.trim() || value.length > 4000)
        throw new Error('Invalid finding text length');
    }
  }
  const allowed = new Set(threads.map((t) => t.id));
  for (const action of result.threads) {
    if (
      !allowed.delete(action.thread_id) ||
      !action.evidence.trim() ||
      action.evidence.length > 4000
    )
      throw new Error('Invalid thread disposition');
  }
  if (allowed.size) throw new Error('Missing open thread disposition');
  return result;
}

async function invoke(snapshot, prompt, signal) {
  const output = join(snapshot.temp, randomUUID() + '.json');
  const [exe, ...args] = codexExecutable();
  await command(
    exe,
    [
      ...args,
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '-c',
      'project_doc_max_bytes=0',
      '--sandbox',
      'read-only',
      '--cd',
      snapshot.worktree,
      '--output-schema',
      snapshot.schemaFile,
      '--output-last-message',
      output,
      '-',
    ],
    {
      cwd: snapshot.temp,
      env: modelEnvironment(process.env, snapshot.emptyGhConfig),
      timeout: 15 * 60_000,
      input: prompt,
      signal,
      discardOutput: true,
    },
  );
  return JSON.parse(await readFile(output, 'utf8'));
}

export async function review(snapshot, input, signal, call = invoke) {
  const boundary = randomUUID();
  const data = (value) =>
    '<untrusted-data-' +
    boundary +
    '>\n' +
    JSON.stringify(value) +
    '\n</untrusted-data-' +
    boundary +
    '>';
  const instructions = [
    snapshot.prompt,
    'Trusted reference documents:',
    JSON.stringify(snapshot.context),
    'Confirmed green L1 rules: ' + JSON.stringify(input.rules),
    'PR metadata, linked issues, open threads and diff:',
    data({
      title: input.title,
      body: input.body,
      issues: input.issues,
      threads: input.threads,
      diff: snapshot.patch,
    }),
  ].join('\n\n');
  const first = validateResult(
    await call(snapshot, instructions, signal),
    snapshot.schema,
    snapshot.anchors,
    input.threads,
  );
  const candidates = first.findings.filter((f) => f.severity === 'Important');
  if (!candidates.length) return { ...first, dropped: 0 };
  const verifier =
    instructions +
    '\n\nIndependently verify ONLY these candidate Important findings against real code, intent and green checks. Return only confirmed candidates with unchanged severity, identifiers and anchors. Drop speculative, duplicate-L1 or unsupported claims. Return an empty threads array.\n' +
    data(candidates);
  const verified = validateResult(
    await call(snapshot, verifier, signal),
    snapshot.schema,
    snapshot.anchors,
    [],
  );
  for (const f of verified.findings) {
    if (
      f.severity !== 'Important' ||
      !candidates.some((c) =>
        ['finding_id', 'file', 'line', 'side', 'bug_class'].every(
          (key) => c[key] === f[key],
        ),
      )
    )
      throw new Error('Verifier returned an unsolicited finding');
  }
  return {
    findings: [
      ...verified.findings,
      ...first.findings.filter((f) => f.severity !== 'Important'),
    ],
    threads: first.threads,
    dropped: candidates.length - verified.findings.length,
  };
}

export function skipReason(error) {
  const text = String(error?.message ?? error);
  if (/rate.limit|quota|usage.limit|429/i.test(text))
    return 'Codex quota or rate limit';
  if (/unauthori|authentication|login|401|refresh.token/i.test(text))
    return 'Codex authentication unavailable';
  if (/timed? ?out|abort|timeout/i.test(text))
    return 'review timed out or was interrupted';
  if (
    /schema|verifier|finding|disposition|Unexpected token|outside the PR diff/i.test(
      text,
    )
  )
    return 'invalid structured review output';
  if (/ENOTFOUND|ECONN|network|fetch failed/i.test(text))
    return 'network unavailable';
  return 'review execution unavailable';
}
