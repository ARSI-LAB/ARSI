import { command } from './process.mjs';

export const summaryMarker = '<!-- arsi-ai-review:summary -->';
const member = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const reviewLabel = 'ai-review';

export function confirmedRules(rules, files) {
  // A green job label cannot attest that a PR editing the gate kept its rules.
  const gateInput =
    /^(?:\.github\/(?:actions|workflows)\/|scripts\/|tests\/|package\.json$|pnpm[-.]|\.pnpmfile|\.npmrc$|tsconfig(?:\.|$)|eslint\.config\.|\.prettier|\.gitattributes$|\.editorconfig$|web\/vite\.config\.)/;
  return files.some((path) => gateInput.test(path)) ? [] : rules;
}

export function greenRules(job) {
  if (job?.conclusion !== 'success') return null;
  const passed = new Set(
    job.steps.filter((s) => s.conclusion === 'success').map((s) => s.name),
  );
  const full = passed.has('Run full checks');
  if (!full && !passed.has('Run documentation checks')) return null;
  const rules = [
    'formatting (checked paths)',
    'bilingual structural pairing and same-PR sync',
    'TypeScript guide snippets',
    'rule document budgets',
    'relative links/anchors and historical document discipline',
  ];
  if (full)
    rules.push(
      'TypeScript typechecking',
      'ESLint type safety, promises, empty catch and Hooks',
      'useEffect boundary',
      'module boundaries and plugin layout',
      'unit tests and build',
    );
  if (passed.has('Run bridge tests')) rules.push('bridge Python tests');
  return rules;
}

export function github(repo, signal, execute = command) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('Invalid GitHub owner/repository');
  const [owner, name] = repo.split('/');
  const base = 'repos/' + repo;
  const gh = (args, input) =>
    execute('gh', ['api', '--hostname', 'github.com', ...args], {
      signal,
      input,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
  const api = async (path, method, data) =>
    JSON.parse(
      await gh(
        [
          path,
          ...(method ? ['-X', method] : []),
          ...(data ? ['--input', '-'] : []),
        ],
        data && JSON.stringify(data),
      ),
    );
  const pages = async (path, field) => {
    const all = JSON.parse(
      await gh([
        '--paginate',
        '--slurp',
        path + (path.includes('?') ? '&' : '?') + 'per_page=100',
      ]),
    );
    return all.flatMap((page) => (field ? page[field] : page));
  };
  const graphql = async (query, variables) => {
    const result = await api('graphql', 'POST', { query, variables });
    if (result.errors?.length) throw new Error('GitHub GraphQL request failed');
    return result.data;
  };
  const permission = async (login) => {
    if (!login || !/^[A-Za-z0-9-]+$/.test(login)) return false;
    const result = await api(base + '/collaborators/' + login + '/permission');
    return ['admin', 'maintain', 'write'].includes(result.permission);
  };
  async function authorization(pr, comments) {
    if (member.has(pr.author_association)) return 'auto';
    if (pr.labels.some((label) => label.name === reviewLabel)) {
      const events = await pages(base + '/issues/' + pr.number + '/events');
      const last = events
        .filter(
          (e) =>
            ['labeled', 'unlabeled'].includes(e.event) &&
            e.label?.name === reviewLabel,
        )
        .at(-1);
      if (last?.event === 'labeled' && (await permission(last.actor?.login)))
        return 'maintainer';
    }
    for (const c of comments.filter(
      (c) =>
        c.body?.trim() === '/ai-review' && member.has(c.author_association),
    )) {
      if (await permission(c.user.login)) return 'maintainer';
    }
    return null;
  }
  async function markReviewStarted(pr) {
    const hasMarker = (labels) =>
      labels.some((label) => label.name.toLowerCase() === reviewLabel);
    if (!member.has(pr.author_association) || hasMarker(pr.labels)) return;
    const labels = await api(
      base + '/issues/' + pr.number + '/labels',
      'POST',
      {
        labels: [reviewLabel],
      },
    );
    if (!hasMarker(labels)) throw new Error('Automatic review label missing');
  }
  async function l1(pr) {
    // Only the named workflow's latest run for this PR snapshot may enable L2.
    const runs = await pages(
      base +
        '/actions/workflows/ci.yml/runs?event=pull_request&head_sha=' +
        pr.head.sha,
      'workflow_runs',
    );
    const run = runs
      .filter(
        (r) =>
          r.head_sha === pr.head.sha &&
          r.head_repository?.id === pr.head.repo?.id &&
          r.head_branch === pr.head.ref &&
          r.event === 'pull_request' &&
          (r.pull_requests?.some(
            (p) =>
              p.number === pr.number &&
              p.base.ref === pr.base.ref &&
              p.head.sha === pr.head.sha,
          ) ||
            (!r.pull_requests?.length &&
              r.display_title === 'L1 PR #' + pr.number + ' ' + pr.head.sha)),
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!run) return null;
    const jobs = await pages(
      base +
        '/actions/runs/' +
        run.id +
        '/attempts/' +
        run.run_attempt +
        '/jobs',
      'jobs',
    );
    return greenRules(jobs.find((j) => j.name === 'CI / Check (Linux)'));
  }
  async function discussions(number, login) {
    const roots = [];
    let cursor = null;
    let issues;
    do {
      const data = await graphql(
        'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number title body repository{nameWithOwner}}} reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{fullDatabaseId author{login} body path line originalLine}}} pageInfo{hasNextPage endCursor}}}}}',
        { owner, name, number, cursor },
      );
      const pr = data.repository.pullRequest;
      issues = pr.closingIssuesReferences.nodes.filter(
        (i) => i.repository.nameWithOwner.toLowerCase() === repo.toLowerCase(),
      );
      for (const thread of pr.reviewThreads.nodes) {
        const first = thread.comments.nodes[0];
        const mark = first?.body.match(
          /^<!-- arsi-ai-review:thread ([a-f0-9]{40}) ([a-z0-9-]+) -->\n/,
        );
        if (mark && first.author?.login === login)
          roots.push({
            id: thread.id,
            resolved: thread.isResolved,
            head: mark[1],
            bug: mark[2],
            root: first,
            replies: [],
          });
      }
      cursor = pr.reviewThreads.pageInfo.hasNextPage
        ? pr.reviewThreads.pageInfo.endCursor
        : null;
    } while (cursor);
    if (roots.length) {
      const byId = new Map(
        roots.map((thread) => [String(thread.root.fullDatabaseId), thread]),
      );
      for (const reply of await pages(
        base + '/pulls/' + number + '/comments',
      )) {
        byId
          .get(String(reply.in_reply_to_id))
          ?.replies.push({ author: reply.user.login, body: reply.body });
      }
    }
    return { threads: roots, issues };
  }
  return {
    login: async () => (await api('user')).login,
    list: () => pages(base + '/pulls?state=open'),
    pr: (n) => api(base + '/pulls/' + n),
    comments: (n) => pages(base + '/issues/' + n + '/comments'),
    authorization,
    markReviewStarted,
    l1,
    discussions,
    summary: (n, id, body) =>
      api(
        id
          ? base + '/issues/comments/' + id
          : base + '/issues/' + n + '/comments',
        id ? 'PATCH' : 'POST',
        { body },
      ),
    review: (n, head, comments) =>
      api(base + '/pulls/' + n + '/reviews', 'POST', {
        event: 'COMMENT',
        body:
          'Verified Important findings for ' +
          head +
          '. See the inline threads.',
        commit_id: head,
        comments,
      }),
    reply: (n, id, body) =>
      api(base + '/pulls/' + n + '/comments/' + id + '/replies', 'POST', {
        body,
      }),
    resolve: (id) =>
      graphql(
        'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}',
        { id },
      ),
  };
}
