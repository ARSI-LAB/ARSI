import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { RuntimeContext } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import type { LocalProvider } from './local-config.js';
import { readFileTool } from './session.js';

function providerFailure(value: unknown, status?: number): Error {
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? object(value)
      : {};
  const error =
    body.error && typeof body.error === 'object' ? object(body.error) : body;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (
    code === 'context_length_exceeded' ||
    /context.{0,30}(?:window|limit|length)|input.{0,20}(?:too long|exceeds)/i.test(
      message,
    )
  )
    return new Error(
      'Codex provider context limit exceeded; reduce task metadata or read smaller virtual-file ranges',
    );
  return new Error(
    status
      ? `Codex provider HTTP ${status}`
      : 'Codex provider reported a failed response',
  );
}

function allowedItem(value: unknown): void {
  const item = object(value);
  if (
    item.type === 'message' ||
    item.type === 'reasoning' ||
    item.type === 'compaction'
  )
    return;
  if (
    item.type === 'function_call' &&
    item.name === 'read_file' &&
    !item.namespace
  )
    return;
  throw new Error('Codex provider returned a forbidden tool call');
}

const maxBytes = 8 * 1024 * 1024;
async function boundedBody(
  source: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('Codex transport exceeds byte limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Buffer before delivery: even a provider returning unrequested tools cannot invoke host tools. */
function validateResponse(body: string): void {
  let completed = false;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    const event = object(JSON.parse(data));
    const type = string(event.type);
    if (
      type === 'error' ||
      type === 'response.failed' ||
      type === 'response.incomplete'
    )
      throw providerFailure(event.response ?? event);
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      allowedItem(event.item);
    }
    if (type === 'response.completed') {
      const response = object(event.response);
      if (response.status && response.status !== 'completed')
        throw providerFailure(response);
      if (!Array.isArray(response.output))
        throw new Error('Invalid Codex response output');
      for (const value of response.output) {
        allowedItem(value);
      }
      completed = true;
    }
  }
  if (!completed)
    throw new Error('Codex provider did not complete the response');
}

/** Owns the sole upstream route; each attempt is charged before leaving this process. */
export async function startGateway(
  provider: LocalProvider,
  timeoutMs: number,
  context: RuntimeContext,
  signal: AbortSignal,
  maxModelCalls: number,
  record: (type: string, data: unknown) => void,
): Promise<{
  url: string;
  token: string;
  failure: () => Error | undefined;
  close: () => Promise<void>;
}> {
  const token = randomBytes(32).toString('hex');
  let calls = 0;
  let failure: Error | undefined;
  let busy = false;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (req.headers['x-rsi-codex'] !== token) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const chatgpt =
        provider.id === 'openai' &&
        typeof req.headers['chatgpt-account-id'] === 'string';
      if (req.method !== 'POST' || url.pathname !== '/api/responses') {
        res.writeHead(404).end();
        return;
      }
      if (busy) {
        res.writeHead(409).end();
        return;
      }
      busy = true;
      try {
        signal.throwIfAborted();
        if (failure) throw failure;
        const body = object(JSON.parse(await boundedBody(req)));
        // The sole executable tool reads the supplied virtual snapshot through app-server RPC.
        body.tools = [
          {
            type: 'function',
            name: readFileTool.name,
            description: readFileTool.description,
            parameters: readFileTool.inputSchema,
          },
        ];
        body.tool_choice = 'auto';
        body.stream = true;
        body.store = false;
        if (calls >= maxModelCalls)
          throw new Error('Agent model-call limit reached');
        await context.charge('modelCalls', 1);
        calls++;
        signal.throwIfAborted();
        record('model_request', { modelCalls: calls });
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (
            value !== undefined &&
            ![
              'host',
              'connection',
              'content-length',
              'transfer-encoding',
              'x-rsi-codex',
            ].includes(name)
          )
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        headers.set('content-type', 'application/json');
        headers.set('accept', 'text/event-stream');
        const base = chatgpt ? provider.chatgptBaseUrl : provider.apiBaseUrl;
        const path =
          chatgpt && base.endsWith('/backend-api')
            ? '/codex/responses'
            : '/responses';
        const response = await fetch(`${base}${path}${url.search}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          // Let Codex refresh its own expired login and retry through the same budget gate.
          if (response.status === 401) {
            await response.body?.cancel();
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: { message: 'Codex authentication required' },
              }),
            );
            return;
          }
          const body = response.body ? await boundedBody(response.body) : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = {};
          }
          throw providerFailure(parsed, response.status);
        }
        if (!response.body)
          throw new Error('Codex provider returned an empty body');
        const output = await boundedBody(response.body);
        validateResponse(output);
        signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(output);
      } catch (error) {
        failure =
          error instanceof SyntaxError
            ? new Error('Invalid Codex provider response')
            : error instanceof Error
              ? error
              : new Error('Codex gateway request failed');
        record('provider_error', { message: failure.message });
        // Provider text and credentials never cross back into Codex or diagnostic errors.
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'RSI Codex request failed' } }),
        );
      } finally {
        busy = false;
      }
    };
    const work = handle();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Codex gateway has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    failure: () => failure,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await Promise.allSettled([...pending]);
      await closed;
    },
  };
}
