# Web observation and HTTP control

From the same workspace as your CLI facts:

```sh
ember-rsi dashboard --port 4317 --plugin-dir .rsi/skill-demo/extension
```

Use the installed `ember-rsi` CLI from an experiment workspace containing a `.rsi` directory. The server binds loopback and serves built Web assets. `pnpm dev:web` starts the Vite frontend and normally still needs a backend on 4317. The frontend displays experiment records and provides Reflection revision preview and application. Start, resume, and cancel through the CLI or backend control routes; the frontend has no Recipe editing or experiment launch controls.

| Request                                                         | Meaning                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET /api/catalog                                                | Registered plugin/Policy ID lists                                  |
| GET /api/experiments                                            | Experiment list                                                    |
| GET /api/experiments/:id                                        | Current record, including status/result/error                      |
| POST /api/experiments                                           | JSON `{ recipePath, id?, resume? }`; HTTP 202 accepted             |
| POST /api/experiments/:id/cancel                                | Requests cancellation                                              |
| GET /api/observation/experiments/:id/revisions/:ref/application | Preview a revision's destination file changes and blocking reasons |
| POST /api/experiments/:id/revisions/:ref/apply                  | Apply the selected revision to its recorded source paths           |

Example from the same machine, after copying the starter:

```sh
curl -sS -H 'Content-Type: application/json' http://127.0.0.1:4317/api/experiments \
  -d '{"recipePath":".rsi/skill-demo/recipe.yaml","id":"web-demo-01"}'
curl -sS http://127.0.0.1:4317/api/experiments/web-demo-01
```

Paths resolve on the server filesystem. HTTP 202 is not successful initialization; poll until terminal status and inspect output and cleanup. Keep the server process alive while it owns jobs. Restarting the server preserves stored observations but does not automatically resume work. Resume posts the same recipePath and id with `resume: true` after checking [recovery constraints](cli.md).

There is no `/api/v1` prefix, Recipe CRUD, launch-preview digest or pause/continue route. Cancel only an active experiment: this revision's terminal-ID cancel handler can surface an unhandled rejection. A successful POST response alone is not evidence that cancellation completed. If the server exits, inspect persisted facts before deciding to restart or resume.

In experiment details, **Reflection & Memory** shows revision and experience records with statuses, reasons, changes, and full contents. Memory records link to their calls. For Reflection, `Preview application` lists destination changes; applying requires reviewing those files, selecting the confirmation checkbox, and clicking `Apply changes`. Application writes the recorded original user resources for future experiments and follows the same overwrite and active-experiment restrictions as the CLI. See the [Reflection guide](../../../docs/users/guides/reflection.md#apply-a-revision-to-future-experiments).

The observation interface reads facts and artifact previews; missing or truncated evidence remains missing/truncated. Do not infer model use, benchmark quality or cleanup from a chart alone.
