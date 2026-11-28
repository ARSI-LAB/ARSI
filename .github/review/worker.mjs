import { confirmedRules, github } from './github.mjs';
import { withSnapshot } from './prepare.mjs';
import { review, skipReason } from './review.mjs';
import { eligible, escalated, publish, skipped, sticky } from './publish.mjs';

async function one(api, number, login, config) {
  const pr = await api.pr(number);
  if (pr.state !== 'open' || !pr.head.repo) return 'closed or unavailable';
  const comments = await api.comments(number);
  const state = sticky(comments, login);
  if (!eligible(state, pr.head.sha, config.manual))
    return 'already reviewed, deferred or round limit reached';
  if (!(await api.authorized(pr, comments)))
    return 'awaiting maintainer opt-in';
  const rules = await api.l1(pr);
  if (!rules)
    return 'awaiting successful CI / Check (Linux) on the current head';

  async function fresh() {
    const current = await api.pr(number);
    if (
      current.state !== 'open' ||
      current.head.sha !== pr.head.sha ||
      current.base.ref !== pr.base.ref
    )
      throw new Error('PR changed during review');
    if (!(await api.authorized(current, await api.comments(number))))
      throw new Error('Maintainer opt-in was withdrawn');
  }
  const { threads, issues } = await api.discussions(number, login);
  const open = threads.filter(
    (t) => !t.resolved && t.head !== pr.head.sha && !escalated(t, login),
  );
  let snapshotInfo, result;
  try {
    await withSnapshot(
      { ...config, pr, previous: state.head },
      async (snapshot) => {
        snapshotInfo = {
          context: snapshot.context.map(({ path }) => ({ path })),
          skillLoaded: snapshot.skillLoaded,
        };
        result = await review(
          snapshot,
          {
            title: pr.title,
            body: pr.body,
            issues,
            threads: open,
            rules: confirmedRules(rules, snapshot.fullPaths),
          },
          config.signal,
        );
      },
    );
  } catch (error) {
    if (config.signal.aborted) throw error;
    const reason = skipReason(error);
    await skipped(api, pr, state, reason, fresh);
    return 'AI Review Skipped (' + reason + ')';
  }
  // Reconcile real GitHub state before publishing, including writes acknowledged late.
  await fresh();
  if (!(await api.l1(await api.pr(number))))
    return 'CI / Check (Linux) changed during review';
  const latest = sticky(await api.comments(number), login);
  if (latest.head !== state.head || latest.round !== state.round)
    return 'another review already published';
  const currentThreads = (await api.discussions(number, login)).threads;
  await publish(
    api,
    pr,
    latest,
    login,
    currentThreads,
    snapshotInfo,
    result,
    fresh,
  );
  return 'reviewed ' + pr.head.sha;
}

export async function run(config) {
  if (config.mode === 'local') {
    await withSnapshot(config, async (snapshot) => {
      if (!snapshot.patch) {
        console.log('No local changes from origin/master.');
        return;
      }
      const result = await review(
        snapshot,
        {
          title: 'Local pre-PR review',
          body: '',
          issues: [],
          threads: [],
          rules: [],
        },
        config.signal,
      );
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }
  const api = github(config.repo, config.signal);
  const login = await api.login();
  const numbers = config.pr
    ? [config.pr]
    : (await api.list()).map((pr) => pr.number);
  let failures = 0;
  for (const number of numbers) {
    try {
      console.log(
        '#' + number + ': ' + (await one(api, number, login, config)),
      );
    } catch (error) {
      if (config.signal.aborted) throw error;
      failures++;
      // Error bodies can contain PR-controlled text or sensitive authentication diagnostics.
      console.error(
        '#' +
          number +
          ': GitHub or review orchestration failed (' +
          skipReason(error) +
          '); verify connectivity, permissions and the trusted checkout.',
      );
    }
  }
  if (failures)
    throw new Error('Could not finish ' + failures + ' pull request(s)');
}
