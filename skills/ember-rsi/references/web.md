# Web observation and HTTP control

From the same workspace as your CLI facts:

```sh
ember-rsi dashboard --port 4317 --plugin-dir .rsi/skill-demo/extension
```

Use the installed `ember-rsi` CLI from an experiment workspace containing a `.rsi` directory. The server binds loopback and serves built Web assets. `pnpm dev:web` starts the Vite frontend and normally still needs a backend on 4317. The current frontend is an observation workspace; do not promise Recipe editing or frontend launch controls. Backend control routes remain available.

| Request                          | Meaning                                                |
| -------------------------------- | ------------------------------------------------------ |
| GET /api/catalog                 | Registered plugin/Policy ID lists                      |
| GET /api/experiments             | Experiment list                                        |
| GET /api/experiments/:id         | Current record, including status/result/error          |
| POST /api/experiments            | JSON `{ recipePath, id?, resume? }`; HTTP 202 accepted |
| POST /api/experiments/:id/cancel | Requests cancellation                                  |

Example from the same machine, after copying the starter:

```sh
curl -sS -H 'Content-Type: application/json' http://127.0.0.1:4317/api/experiments \
  -d '{"recipePath":".rsi/skill-demo/recipe.yaml","id":"web-demo-01"}'
curl -sS http://127.0.0.1:4317/api/experiments/web-demo-01
```

Paths resolve on the server filesystem. HTTP 202 is not successful initialization; poll until terminal status and inspect output and cleanup. Keep the server process alive while it owns jobs. Restarting the server preserves stored observations but does not automatically resume work. Resume posts the same recipePath and id with `resume: true` after checking [recovery constraints](cli.md).

There is no `/api/v1` prefix, Recipe CRUD, launch-preview digest or pause/continue route. Cancel only an active experiment: this revision's terminal-ID cancel handler can surface an unhandled rejection. A successful POST response alone is not evidence that cancellation completed. If the server exits, inspect persisted facts before deciding to restart or resume.

The observation interface reads facts and artifact previews; missing or truncated evidence remains missing/truncated. Do not infer model use, benchmark quality or cleanup from a chart alone.
