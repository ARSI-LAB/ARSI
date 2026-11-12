import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';

export interface GymHttpClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class GymHttpError extends Error {
  constructor(
    readonly path: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`Gym ${path} failed with HTTP ${statusCode}: ${body.slice(0, 300)}`);
    this.name = 'GymHttpError';
  }
}

export class GymHttpClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GymHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30 * 1000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  post(
    path: string,
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    return this.request(path, 'POST', body, signal);
  }

  get(path: string, signal: AbortSignal): Promise<JsonObject> {
    return this.request(path, 'GET', undefined, signal);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: JsonObject | undefined,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, timeout]),
    });
    const text = await response.text();
    if (!response.ok) throw new GymHttpError(path, response.status, text);
    return object(JSON.parse(text), `${path} response`);
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function optionalObject(
  value: JsonValue | undefined,
): JsonObject | null {
  return value === undefined || value === null ? null : object(value);
}
