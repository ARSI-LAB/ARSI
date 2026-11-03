# Documentation guidelines

This file defines documentation organization and maintenance. See the [root AGENTS.md](../AGENTS.md) for development workflow, directory responsibilities, and commit format.

## Directory responsibilities

| Location             | Content                                                                       | Maintenance                                                         |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `design/YYYY-MM-DD/` | RSI protocols, role responsibilities, strategies, and interface designs       | Append-only; retain the latest 14 days, including the boundary date |
| `tasks/YYYY-MM-DD/`  | Development plans, progress, and acceptance for the RSI library               | Append-only; retain the latest 5 days, including the boundary date  |
| `users/`             | Project introduction, installation, configuration, usage, and troubleshooting | Maintain paired `en/` and `zh-CN/` guides against current behavior  |
| `lessons/`           | Reusable lessons                                                              | Record established conclusions with evidence references             |

Create directories only when needed; do not create empty placeholders. Store runtime data, logs, temporary scripts, one-off checks, and raw trajectories in `.scratch/` or other locations specified by the root guidelines, outside formal documentation directories.

Create design documents, task breakdowns, and task records only when explicitly requested by the user, as specified in the root guidelines. The organization and retention rules below govern requested records; they do not require documents for every request or change.

## Retention and date directories

- Retain designs for no more than 14 days and tasks for no more than 5 days according to document dates, including files on the boundary date. Moving files or repairing links does not reset a document's date.
- Store documents from the same day under `design/YYYY-MM-DD/` or `tasks/YYYY-MM-DD/`, with a separate file for each topic. Keep dates in filenames; move existing files without rewriting their content for consistency.
- Prefer `YYYY-MM-DD` or `YYYYMMDD` in the filename as the document date. For older undated files, use the date first tracked by Git rather than guessing from modification time.
- Remove expired documents from the working tree while retaining Git history. Replace references that still need traceability with historical links to a specific commit before cleanup. Do not redate old documents to bypass retention.

## Append-only historical documents

- **Do not update delivered design/task documents.** When the user explicitly requests new design/task documentation, record new decisions, progress, revisions, acceptance results, and corrections in a new document dated today. Reference earlier documents and explain what is supplemented or superseded. Otherwise, report these in the delivery response. Do not append sections to earlier documents, revise their status, or overwrite conclusions.
- A document created during the current, undelivered task may be completed with its plan, progress, and results during that task. When the user requests documentation for later work, use a new continuation. Create only the requested design and task records; do not duplicate them into separate plan, progress, and result files.
- Retention cleanup, moves into date directories, and necessary link repairs are structural maintenance and must not rewrite historical content. README files, navigation, and AGENTS.md are entrypoints and rules that may be maintained as the structure changes.
- This rule replaces earlier conventions of continuously updating an original document for the same topic.

## Naming and writing

- User guides live in `users/en/` and `users/zh-CN/` with matching filenames and sections. Add reciprocal language links, keep commands/configuration examples aligned, and update both languages when behavior changes. Root README files link to the matching language. Historical design/task records do not require parallel translations.

- Name new designs `YYYY-MM-DD-<topic>.md` and new tasks `YYYY-MM-DD-<type>-<topic>.md`. Add a two-digit sequence when needed to distinguish same-day documents. Use short English kebab-case topics. Preserve existing filenames.
- Use English by default for documentation, comments, prompts, example prose, UI text, and repository metadata. Follow the user's language in conversation, including Chinese when the user writes Chinese. Use UTF-8 and LF, with a final newline. Use relative links; cross-date references must include the correct date directory, and expired material must use links to specific Git commits.
- Task records must state type, status, goal, plan, acceptance criteria, and actual results. Define each fact once and reference it elsewhere; tasks must not copy entire designs.
- Distinguish design goals, implemented code, static checks, simulated verification, real runs, and score improvements. Record unexecuted, failed, skipped, and unknown usage honestly. Historical evidence is not current verification.
- Formal experiment records state key configuration, scoring rules, main results, usage, and failures. Exclude temporary output and complete raw records. Sanitize shared materials; do not include secrets or personal machine configuration.
- Check links and formatting after moves or cleanup. Reference locations in historical documents may be repaired, but their conclusions must remain unchanged.
