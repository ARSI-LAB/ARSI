# Check and review a pull request

English | [简体中文](ci-review_zh.md) · [Getting started](../getting-started.md)

## Before opening a PR

Run `pnpm install --frozen-lockfile` in a source checkout and then `pnpm check`. The checks cover formatting, ESLint, import boundaries, plugin layout, documentation, TypeScript, unit tests, and the build. For paired guides, change both languages together. TypeScript fences are compiled against the public package types. Use `ts file=example.ts` to connect blocks in the same guide and `ts ignore-check` for pseudocode.

To check documentation across all commits on your branch, run `node scripts/check-docs.mjs --base origin/master --head HEAD`.

With a signed-in Codex CLI, run `pnpm review:local` for an optional review of the local changes. The command reads the review configuration from the fetched `origin/master` and prints results to the terminal. Include verification output, affected subsystems and rollback steps in the PR.

## Hosted checks

Draft PRs skip all hosted CI jobs. Marking a PR ready for review starts CI even without a new commit. Converting it back to draft cancels any CI run in progress for that PR. You can run `pnpm check` and `pnpm review:local` while drafting.

`CI / Detect changes` compares the proposed merge with its base for ready PRs and merge groups. Once it finishes, the Linux check, package check and Windows test shards can run in parallel. Each job that installs dependencies caches the pnpm store and uses the frozen lockfile.

- `CI / Check (Linux)` runs `pnpm check` and also runs the Python bridge tests when bridge inputs change. A nonempty diff confined to `docs/` and root-level Markdown takes the `pnpm check:docs` path. An empty diff or a Markdown change under `src/`, `.github/`, `examples/` or `skills/` runs the full check.
- `CI / Package` installs and tests the package as an independent consumer when packaging inputs change. Otherwise it reports success without installing dependencies.
- `CI / Test (Windows)` reports the combined result of three Windows jobs. Node 24 distributes the full unit suite across shards 1/3, 2/3 and 3/3. All three must pass for code changes. Documentation-only PRs start no Windows runner, and the combined check reports success after change detection succeeds.

## Run the maintainer worker

Use a dedicated, maintainer-controlled checkout with `origin` pointing to the repository that receives the PRs. Install the locked dependencies and sign in to the Codex CLI and GitHub CLI. The outer worker needs GitHub access to read Actions, apply PR labels, post comments and resolve review threads. Start one `pnpm review:worker` process and leave it running. Stop it with Ctrl+C. To inspect one PR once, run:

```sh
pnpm review:worker --once --repo ARSI-LAB/ARSI --pr 123
```

The worker skips draft PRs before applying labels or starting a review. If a PR returns to draft during review, the worker stops publishing results once it detects the change. Existing labels stay on the PR.

Ready PRs from repository owners, members and collaborators qualify automatically. For an external contributor, a maintainer must apply the `ai-review` label or comment `/ai-review` to authorize review. In both cases, the worker waits for `CI / Check (Linux)` to pass on the current PR head and prepares a review snapshot. For automatically authorized PRs, the worker adds `ai-review` when Codex first reports review activity.

The worker and local review both read the [review skill](../../../.github/review/skill/SKILL.md) from the trusted default branch. They also load applicable guides and any matching topic files in `.github/review/skill/references/`. Codex inspects an ephemeral worktree with its native read-only sandbox. The outer worker publishes the result.

The Codex process inherits `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, including lowercase spellings. It uses the default Codex provider and CLI sign-in. The worker passes `--ignore-user-config`, so custom providers, MCP servers and hooks in your user configuration do not apply.

The label applies to the whole PR. To confirm that review finished for the current head, compare its SHA with the most recent completed review in the sticky summary. The summary also records the round and verifier result. Verified Important findings open inline threads on additions, deletions or visible context. Nit and Pre-existing findings appear in the summary and may reference other lines of a changed file. Reply to an inline finding with a fix or rationale.

A new commit triggers review of the changes since the last reviewed head and any open threads. If the previous commit falls outside the current PR history after an amend, rebase or base merge, the worker reviews the full current PR diff. It selects guides using all files changed by the PR in every round. After three rounds, a maintainer can request another new-head review with `--pr 123 --manual`. A `[needs-human]` thread calls for a maintainer decision. If a later attempt is skipped, the sticky summary shows the attempted SHA above the last completed review. When AI review is skipped or the workstation is offline, perform a full human review.

## Configure the merge gate

After a workflow run registers the new names on GitHub, replace the previous required status checks in the `master` ruleset with these three exact names:

- `CI / Check (Linux)`
- `CI / Package`
- `CI / Test (Windows)`

Require one human approval, dismissal of stale approvals and resolved conversations. Protect the branch against force pushes and deletion. Enable first-time contributor workflow approval, the merge queue and squash merging. A human approves and enqueues the PR. L2 publishes advisory reviews through GitHub's COMMENT event.
