/** Run with: pnpm exec vite tests/fixtures/web-observation-cache --host 127.0.0.1
 * Browser regression fixture: actual React hooks, controlled public HTTP responses. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  useObservation,
  type QueryState,
} from '../../../web/features/experiments/use-observation';

const root = createRoot(document.getElementById('root')!);
const output = document.getElementById('result')!;
let latest: QueryState<string>;
let requests = 0;
let respond: ((text: string) => void) | undefined;
const parse = (raw: unknown): string => {
  if (typeof raw !== 'string') throw new Error('Expected text fixture');
  return raw;
};
function Probe({
  path,
  completed = false,
  fresh = false,
}: {
  path: string;
  completed?: boolean;
  fresh?: boolean;
}): React.JSX.Element {
  latest = useObservation(
    path,
    parse,
    null,
    completed,
    fresh ? { cache: false } : undefined,
  );
  return <div>{latest.loading ? 'Loading' : latest.data}</div>;
}
function check(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for render');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function reply(text: string): Promise<void> {
  await until(() => respond !== undefined);
  const complete = respond!;
  respond = undefined;
  complete(text);
  await until(() => latest.data === text);
}
function leave(): void {
  flushSync(() => root.render(null));
}
document.getElementById('run')!.onclick = async () => {
  const fetch = window.fetch;
  const run = crypto.randomUUID();
  requests = 0;
  respond = undefined;
  window.fetch = async () => {
    requests++;
    return new Promise<Response>((resolve) => {
      respond = (text) =>
        resolve(new Response(JSON.stringify(text), { status: 200 }));
    });
  };
  try {
    const previewPath = `/${run}/revisions/a/application?inspection=1`;
    flushSync(() => root.render(<Probe path={previewPath} fresh />));
    await reply('replace checks.md');
    leave();
    // Switching revisions remounts the preview and resets its inspection counter.
    flushSync(() => root.render(<Probe path={previewPath} fresh />));
    check(
      latest.loading && latest.data === undefined,
      'Old preview must not enable confirmation while the new plan loads',
    );
    await reply('replace checks.md; delete newly-created.md');
    check(
      requests === 2,
      'Returning to a revision must fetch its changed destination plan',
    );
    leave();

    const callPath = `/${run}/calls/call-a`;
    flushSync(() => root.render(<Probe path={callPath} />));
    await reply('running; no output');
    leave();
    // The call finishes while its details are unmounted.
    flushSync(() => root.render(<Probe path={callPath} completed />));
    check(
      latest.loading && latest.data === undefined,
      'Running response must not become a completed cache hit',
    );
    await reply('succeeded; final output');
    check(requests === 4, 'Final output must be fetched after returning');
    leave();
    flushSync(() => root.render(<Probe path={callPath} completed />));
    check(
      latest.data === 'succeeded; final output',
      'Completed response remains reusable',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(requests === 4, 'Completed response should avoid redundant requests');
    output.textContent =
      'PASS: remounted application preview fetches a fresh plan and blocks stale confirmation.\nPASS: completed call fetches final output after leaving while running, then reuses it.\n4 HTTP reads.';
  } catch (error) {
    output.textContent = `FAIL: ${String(error)}`;
  } finally {
    leave();
    window.fetch = fetch;
  }
};
