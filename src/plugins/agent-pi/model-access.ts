import type { JsonObject } from '../../contracts/json.js';

export interface ModelAccessInput {
  side: 'Proposal' | 'Evaluation';
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ModelAccessResult {
  status: 'passed' | 'failed';
  reason: string;
  details: JsonObject;
}

/** Check model discovery without issuing an inference request. */
export async function probeModelAccess(
  input: ModelAccessInput,
  signal?: AbortSignal,
): Promise<ModelAccessResult> {
  signal?.throwIfAborted();
  const side = input.side.toLowerCase();
  const details: JsonObject = { side: input.side, model: input.model };
  const result = {
    failed(failure: string, reason: string): ModelAccessResult {
      return { status: 'failed', reason, details: { ...details, failure } };
    },
  };
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error('Invalid model service URL');
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/models`;
  } catch {
    return result.failed(
      'invalid-url',
      `${input.side} has an invalid model service address; check the ${side} base_url field.`,
    );
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? 10_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.apiKey}` },
      redirect: 'error',
      signal: requestSignal,
    });
    details.httpStatus = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        return result.failed(
          'access-denied',
          `${input.side} access to the model service was denied; check the ${side} API key and permissions.`,
        );
      }
      return result.failed(
        'http-status',
        `${input.side} model service returned HTTP ${response.status}; check the ${side} base_url and service status.`,
      );
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            return result.failed(
              'response-too-large',
              `${input.side} model list exceeded the 1 MiB response limit; check the ${side} base_url and model service response.`,
            );
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    let body: unknown;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = chunks
        .map((chunk) => decoder.decode(chunk, { stream: true }))
        .join('');
      body = JSON.parse(text + decoder.decode());
    } catch {
      return result.failed(
        'invalid-json',
        `${input.side} model service returned invalid JSON; check the ${side} base_url and model service response.`,
      );
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !Array.isArray(body.data) ||
      !body.data.every(
        (model: unknown) =>
          model !== null &&
          typeof model === 'object' &&
          'id' in model &&
          typeof model.id === 'string' &&
          model.id.trim().length > 0,
      )
    ) {
      return result.failed(
        'invalid-model-list',
        `${input.side} model service returned an invalid model list; check the ${side} base_url and the response data[].id fields.`,
      );
    }
    details.modelCount = body.data.length;
    if (!body.data.some((model: { id: string }) => model.id === input.model)) {
      return result.failed(
        'model-absent',
        `${input.side} connected to the model service but its model list did not contain ${JSON.stringify(input.model)}; check the ${side} model name.`,
      );
    }
    return {
      status: 'passed',
      reason: `${input.side} connected to the model service and found configured model ${JSON.stringify(input.model)}.`,
      details,
    };
  } catch {
    signal?.throwIfAborted();
    if (timeout.signal.aborted) {
      return result.failed(
        'timeout',
        `${input.side} timed out waiting for the model service; check the ${side} base_url and execution environment network.`,
      );
    }
    return result.failed(
      'network',
      `${input.side} could not reach the model service; check the ${side} base_url and execution environment network.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
