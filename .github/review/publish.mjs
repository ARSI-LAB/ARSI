import { summaryMarker } from './github.mjs';

export function sticky(comments, login) {
  const comment = comments.find(
    (c) => c.user.login === login && c.body.startsWith(summaryMarker + '\n'),
  );
  if (!comment) return { round: 0, nits: [] };
  const match = comment.body.match(
    /\n<!-- arsi-ai-review:state ([A-Za-z0-9_-]+) -->$/,
  );
  if (!match) throw new Error('Unreadable AI review summary state');
  const state = JSON.parse(Buffer.from(match[1], 'base64url').toString());
  if (
    !Number.isSafeInteger(state.round) ||
    state.round < 0 ||
    !Array.isArray(state.nits) ||
    state.nits.length > 3 ||
    (state.head && !/^[a-f0-9]{40}$/.test(state.head))
  )
    throw new Error('Invalid AI review summary state');
  return { ...state, id: comment.id };
}

export function eligible(state, head, manual = false, now = Date.now()) {
  return (
    state.head !== head &&
    (manual ||
      (state.round < 3 && !(state.failed === head && state.retryAt > now)))
  );
}

function summary(text, state) {
  const { id, ...metadata } = state;
  return (
    summaryMarker +
    '\n' +
    text +
    '\n<!-- arsi-ai-review:state ' +
    Buffer.from(JSON.stringify(metadata)).toString('base64url') +
    ' -->'
  );
}

// Never let model text produce HTML/marker injection, @mentions, images or user-supplied links.
function plain(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '＠')
    .replace(/[\\\x60*_[\]~|!#]/g, '\\$&')
    .replace(/\s+/g, ' ')
    .trim();
}

function threadBody(head, f, related) {
  return [
    '<!-- arsi-ai-review:thread ' + head + ' ' + f.bug_class + ' -->',
    '**[Important]** ' + f.bug_class + ' / ' + f.finding_id,
    '**Problem** ' + plain(f.problem),
    '**Impact** ' + plain(f.impact),
    '**Recommendation** ' + plain(f.recommendation),
    '<details><summary>Evidence, remediation and acceptance</summary>',
    plain(f.file) +
      ' (' +
      f.side +
      ' line ' +
      f.line +
      '). ' +
      plain(f.evidence),
    '**Remediation** ' + plain(f.remediation),
    '**Acceptance** ' + plain(f.acceptance),
    related.length
      ? 'Additional occurrences: ' +
        related
          .map((r) => plain(r.file) + ' (' + r.side + ' ' + r.line + ')')
          .join(', ')
          .slice(0, 10000)
      : '',
    '</details>',
  ]
    .filter(Boolean)
    .join('\n\n')
    .replace(' -->\n\n', ' -->\n');
}

const actionMarker = (head, kind) =>
  '<!-- arsi-ai-review:action ' + head + ' ' + kind + ' -->';
export const escalated = (thread, login) =>
  thread.replies.some(
    (r) =>
      r.author === login &&
      /^<!-- arsi-ai-review:action [a-f0-9]{40} disagree -->\n/.test(r.body),
  );

export async function skipped(api, pr, state, reason, fresh) {
  await fresh();
  await api.summary(
    pr.number,
    state.id,
    summary(
      '⚠️ AI Review Skipped (' +
        reason +
        ') — proceed with standard full manual review.\n\nAttempted head ' +
        pr.head.sha +
        '. Completed rounds: ' +
        state.round +
        '.',
      { ...state, failed: pr.head.sha, retryAt: Date.now() + 30 * 60_000 },
    ),
  );
}

export async function publish(
  api,
  pr,
  state,
  login,
  threads,
  snapshot,
  result,
  fresh,
) {
  const head = pr.head.sha;
  const nits = new Set(state.nits);
  const findings = result.findings.filter((f) => {
    if (f.severity !== 'Nit' || nits.has(f.finding_id)) return true;
    if (nits.size >= 3) return false;
    nits.add(f.finding_id);
    return true;
  });
  const important = Map.groupBy(
    findings.filter((f) => f.severity === 'Important'),
    (f) => f.bug_class,
  );
  const pending = [];
  for (const [bug, group] of important) {
    if (threads.some((t) => t.bug === bug && (!t.resolved || t.head === head)))
      continue;
    const [first, ...related] = group;
    pending.push({
      path: first.file,
      side: first.side,
      line: first.line,
      body: threadBody(head, first, related),
    });
  }
  const slots = Math.max(0, 10 - threads.filter((t) => t.head === head).length);
  if (pending.length && slots > 0) {
    await fresh();
    await api.review(pr.number, head, pending.slice(0, slots));
  }
  for (const action of result.threads) {
    const t = threads.find((t) => t.id === action.thread_id);
    if (
      !t ||
      t.resolved ||
      t.head === head ||
      escalated(t, login) ||
      action.disposition === 'open'
    )
      continue;
    const disagree = action.disposition === 'disagree';
    if (
      disagree &&
      !t.replies.some(
        (r) =>
          r.author !== login ||
          !r.body.startsWith('<!-- arsi-ai-review:action '),
      )
    )
      continue;
    const marker = actionMarker(head, action.disposition);
    if (
      !t.replies.some(
        (r) => r.author === login && r.body.startsWith(marker + '\n'),
      )
    ) {
      await fresh();
      const message = disagree
        ? '[needs-human] ' +
          plain(action.evidence) +
          '\n\nFixing agents: stop pushing speculative changes. Ask the author or maintainer to adjudicate this thread directly.'
        : 'Verified ' +
          action.disposition +
          ' at ' +
          head +
          '. ' +
          plain(action.evidence);
      await api.reply(pr.number, t.root.databaseId, marker + '\n' + message);
    }
    if (!disagree) {
      await fresh();
      await api.resolve(t.id);
    }
  }
  const round = state.round + 1;
  let body = findings.length
    ? '**' + findings.length + ' finding(s)**'
    : '**0 issues in the reviewed changes**';
  body +=
    '\n\nReviewed ' +
    head +
    ' · Round ' +
    Math.min(round, 3) +
    '/3' +
    (round > 3 ? ' (manual run ' + round + ')' : '') +
    '. Verifier dropped ' +
    result.dropped +
    '.';
  body +=
    '\n\nTrusted context: .github/review/system-prompt.md, ' +
    snapshot.context.map((doc) => plain(doc.path)).join(', ') +
    '.';
  if (!snapshot.skillLoaded)
    body += ' Team review skill pending publication; used the base prompt.';
  if (findings.length) {
    body += '\n\n| Severity | Location | Finding |\n| --- | --- | --- |';
    for (const [index, f] of findings.entries()) {
      const row =
        '\n| ' +
        f.severity +
        ' | ' +
        plain(f.file) +
        ' (' +
        f.side +
        ' ' +
        f.line +
        ') | ' +
        plain(f.problem) +
        ' |';
      if (body.length + row.length > 55000) {
        body +=
          '\n\nAdditional findings omitted from this table: ' +
          (findings.length - index) +
          '.';
        break;
      }
      body += row;
    }
  }
  if (pending.length > slots)
    body +=
      '\n\nInline thread cap reached. Inspect the remaining Important findings in this table.';
  if (round >= 3)
    body +=
      '\n\nPause and re-evaluate the overall approach with a maintainer. Further reviews require manual invocation.';
  await fresh();
  await api.summary(
    pr.number,
    state.id,
    summary(body, { round, head, nits: [...nits] }),
  );
}
