# Check and review a pull request

English | [简体中文](ci-review_zh.md) · [Getting started](../getting-started.md)

## Before opening a PR

Run `pnpm install --frozen-lockfile` in a source checkout and then `pnpm check`. The checks cover formatting, ESLint, import boundaries, plugin layout, documentation, TypeScript, unit tests, and the build. For paired guides, change both languages together. TypeScript fences are compiled against the public package types. Use `ts file=example.ts` to connect blocks in the same guide and `ts ignore-check` for pseudocode.

To check documentation across all commits on your branch, run `node scripts/check-docs.mjs --base origin/master --head HEAD`.

With a signed-in Codex CLI, run `pnpm review:local` for an optional review of the local changes. The command reads the review configuration from the fetched `origin/master` and prints results to the terminal. Include verification output, affected subsystems and rollback steps in the PR.

## Hosted checks

`CI / Detect changes` compares the proposed merge with its base for both pull requests and merge groups. Once it finishes, the Linux check, package check and Windows test shards can run in parallel. Each job that installs dependencies caches the pnpm store and uses the frozen lockfile.

- `CI / Check (Linux)` runs `pnpm check` and also runs the Python bridge tests when bridge inputs change. A nonempty diff confined to `docs/` and root-level Markdown takes the `pnpm check:docs` path. An empty diff or a Markdown change under `src/`, `.github/`, `examples/` or `skills/` runs the full check.
- `CI / Package` installs and tests the package as an independent consumer when packaging inputs change. Otherwise it reports success without installing dependencies.
- `CI / Test (Windows)` reports the combined result of three Windows jobs. Node 24 distributes the full unit suite across shards 1/3, 2/3 and 3/3. All three must pass for code changes. Documentation-only PRs start no Windows runner, and the combined check reports success after change detection succeeds.

## Run the maintainer worker

Use a dedicated, maintainer-controlled checkout with `origin` pointing to the repository that receives the PRs. Install the locked dependencies and sign in to the Codex CLI and GitHub CLI. The outer worker needs GitHub access to read Actions and publish PR comments and thread resolutions. Start one `pnpm review:worker` process and leave it running. Stop it with Ctrl+C. To inspect one PR once, run:

```sh
pnpm review:worker --once --repo ARSI-LAB/ARSI --pr 123
```

The worker checks for a successful `CI / Check (Linux)` on the current PR head. Member PRs qualify automatically. For an external contributor, a maintainer applies the `ai-review` label or comments `/ai-review`. Review uses the trusted base prompt, applicable guides and, when published, the team review skill. Codex inspects an ephemeral worktree with its native read-only sandbox. The outer worker publishes the result.

The Codex process inherits `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, including lowercase spellings. It uses the default Codex provider and CLI sign-in. The worker passes `--ignore-user-config`, so custom providers, MCP servers and hooks in your user configuration do not apply.

Read the sticky summary for the reviewed SHA, round and verifier result. Verified Important findings open inline threads on additions, deletions or visible context. Nit and Pre-existing findings appear in the summary and may reference other lines of a changed file. Reply to an inline finding with a fix or rationale.

A new commit triggers review of the changes since the last reviewed head and any open threads. If the previous commit falls outside the current PR history after an amend, rebase or base merge, the worker reviews the full current PR diff. It selects guides using all files changed by the PR in every round. After three rounds, a maintainer can request another new-head review with `--pr 123 --manual`. A `[needs-human]` thread calls for a maintainer decision. If a later attempt is skipped, the sticky summary shows the attempted SHA above the last completed review. When AI review is skipped or the workstation is offline, perform a full human review.

## Configure the merge gate

After a workflow run registers the new names on GitHub, replace the previous required status checks in the `master` ruleset with these three exact names:

- `CI / Check (Linux)`
- `CI / Package`
- `CI / Test (Windows)`

Require one human approval, dismissal of stale approvals and resolved conversations. Protect the branch against force pushes and deletion. Enable first-time contributor workflow approval, the merge queue and squash merging. A human approves and enqueues the PR. L2 publishes advisory reviews through GitHub's COMMENT event.
