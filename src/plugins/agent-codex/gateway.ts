import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { RuntimeContext } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import type { ResolvedAgentCodexConfig } from './schema.js';

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
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      const item = object(event.item);
      if (item.type !== 'message' && item.type !== 'reasoning')
        throw new Error('Codex provider returned a forbidden tool call');
    }
    if (type === 'response.completed') {
      const response = object(event.response);
      if (!Array.isArray(response.output))
        throw new Error('Invalid Codex response output');
      for (const value of response.output) {
        const item = object(value);
        if (item.type !== 'message' && item.type !== 'reasoning')
          throw new Error('Codex provider returned a forbidden tool call');
      }
      completed = true;
    }
  }
  if (!completed)
    throw new Error('Codex provider did not complete the response');
}

/** Owns the sole upstream route; each attempt is charged before leaving this process. */
export async function startGateway(
  config: ResolvedAgentCodexConfig,
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
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
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
        // Supplied snapshots are in the prompt. No filesystem, shell, network or hosted tools.
        body.tools = [];
        body.tool_choice = 'none';
        body.model = config.model;
        // Match agent.pi: off omits reasoning controls, including CLI defaults.
        if (config.thinkingLevel === 'off') delete body.reasoning;
        body.stream = true;
        body.store = false;
        if (calls >= maxModelCalls)
          throw new Error('Agent model-call limit reached');
        await context.charge('modelCalls', 1);
        calls++;
        signal.throwIfAborted();
        record('model_request', { modelCalls: calls });
        const response = await fetch(
          `${config.base_url.replace(/\/$/, '')}/responses`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.api_key}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify(body),
            signal,
            redirect: 'error',
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Codex provider HTTP ${response.status}`);
        }
        if (!response.body)
          throw new Error('Codex provider returned an empty body');
        const output = await boundedBody(response.body);
        validateResponse(output);
        signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(output);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
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
  server.requestTimeout = config.timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Codex gateway has no address');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
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
