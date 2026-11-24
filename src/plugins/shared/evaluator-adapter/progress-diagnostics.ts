import { STATUS_CODES } from 'node:http';
import { ERROR_CODES, type ProgressEvent } from 'arsi-evaluator';

const diagnosticsHint = 'See saved Evaluator diagnostics if available.';
const attemptIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const modelReasons = new Map([
  ['MODEL_AUTH_FAILED', 'Model API authentication or permissions failed'],
  ['MODEL_CONTEXT_LIMIT', 'Model input exceeds the context limit'],
  ['MODEL_QUOTA_EXHAUSTED', 'Model quota is exhausted'],
  ['MODEL_RATE_LIMIT', 'Model API rate limit reached'],
  ['MODEL_REQUEST_INVALID', 'Model API rejected the request'],
  ['MODEL_UNAVAILABLE', 'Model API is unavailable'],
  ['MODEL_UPSTREAM_TIMEOUT', 'Model API request timed out'],
]);

const networkReasons = new Map([
  ['connection-failed', 'Network connection failed'],
  ['connection-interrupted', 'Network connection was interrupted'],
  ['dns', 'DNS resolution failed'],
  ['http-transient', 'Transient HTTP error'],
  ['rate-limit', 'Request rate limit reached'],
  ['response-truncated', 'Model response ended before completion'],
  ['transport-timeout', 'Network request timed out'],
]);

const transportReasons = new Map([
  ['EAI_AGAIN', 'Temporary DNS failure'],
  ['ECONNREFUSED', 'Connection refused'],
  ['ECONNRESET', 'Connection reset'],
  ['EHOSTUNREACH', 'Host unreachable'],
  ['ENETUNREACH', 'Network unreachable'],
  ['ENOTFOUND', 'DNS lookup failed'],
  ['EPIPE', 'Connection closed while writing'],
  ['ETIMEDOUT', 'Connection timed out'],
]);

const providerReasons = new Map([
  [
    'insufficient_balance_error',
    { statuses: [402], reason: 'Model account has insufficient balance' },
  ],
  [
    'insufficient_quota',
    { statuses: [402, 429], reason: 'Model quota is exhausted' },
  ],
  [
    'context_length_exceeded',
    {
      statuses: [400, 413, 422],
      reason: 'Model input exceeds the context limit',
    },
  ],
]);

function transportReason(code: string | undefined): string | undefined {
  const reason = code && transportReasons.get(code);
  return reason ? `${code} · ${reason}` : undefined;
}

function httpReason(status: number): string {
  const reason =
    status === 429 ? 'Request rate limit reached' : STATUS_CODES[status];
  return reason ? `HTTP ${status} · ${reason}` : `HTTP ${status}`;
}

/** DSH wraps provider HTTP errors in text. Read only the status and known labels. */
function dshHttpFailure(
  message: string,
): { status: number; reason: string } | undefined {
  const response =
    /^(?:HTTP(?: Error)?[ \t]+|Error code:[ \t]+)?([45]\d{2})[ \t]*[:-][ \t]*(\{[\s\S]*\})$/u.exec(
      message,
    );
  const labeledStatus =
    /^(?:HTTP(?: Error)?[ \t]+|Error code:[ \t]+)([45]\d{2})(?=$|[ \t:-])/u.exec(
      message,
    );
  const status = Number(response?.[1] ?? labeledStatus?.[1]);
  if (!Number.isInteger(status)) return undefined;
  const http = { status, reason: httpReason(status) };
  if (response) {
    try {
      let body: unknown = JSON.parse(response[2]!);
      if (body && typeof body === 'object' && 'error' in body)
        body = body.error;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const {
          code,
          type,
          message: providerMessage,
        } = body as Record<string, unknown>;
        for (const label of [type, code]) {
          const provider =
            typeof label === 'string' ? providerReasons.get(label) : undefined;
          if (provider?.statuses.includes(status))
            return { status, reason: `HTTP ${status} · ${provider.reason}` };
        }
        if (
          typeof providerMessage === 'string' ||
          typeof code === 'string' ||
          typeof type === 'string'
        )
          return http;
      }
    } catch {
      // An explicitly labeled status remains usable if the body was truncated.
    }
  }
  return labeledStatus ? http : undefined;
}

function textTransportReason(
  message: string,
  npmOutput: boolean,
): string | undefined {
  const transport =
    /^(?:Error: )?(?:(?:read|write|connect|getaddrinfo) )?([A-Z][A-Z0-9_]*)(?=$|[ :\t])/u.exec(
      message,
    );
  const npm = npmOutput
    ? /^(?:#\d+ [\d.]+ )?npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)\r?$/mu.exec(
        message,
      )
    : undefined;
  return transportReason(transport?.[1]) ?? transportReason(npm?.[1]);
}

export function summarizeSdkDiagnostic(
  event: ProgressEvent,
  phase: string,
): { notice: string; verboseNotice?: string } {
  const { failure, attemptId } = event;
  const code = failure?.code;
  const registered =
    typeof code === 'string' && Object.hasOwn(ERROR_CODES, code);
  const details = failure?.details;
  const causes = failure?.causes?.slice(0, 15) ?? [];
  const status = details?.httpStatus;
  const httpStatus =
    status !== undefined &&
    Number.isSafeInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined;
  const causeCodes = [
    details?.originalCode,
    ...causes.map((cause) => cause.code),
  ];
  const model =
    modelReasons.get(code ?? '') ??
    causeCodes.map((value) => modelReasons.get(value ?? '')).find(Boolean);
  const transport = [...causeCodes, details?.networkEvidence]
    .map(transportReason)
    .find(Boolean);

  // Do not interpret arbitrary SDK text (including tool output) as diagnostics.
  // Only recognize bounded causes with a known error format.
  const causeMessages = causes
    .map((cause) => cause.message)
    .filter((message) => typeof message === 'string' && message.length <= 2048);
  // SDK progress normalization can replace the original error name.
  const response =
    code === 'SOLVER_RESULT_INCOMPLETE' &&
    phase === 'solve' &&
    (details?.originalName === 'DshProtocolError' ||
      failure?.message === 'DSH turn ended with reason error')
      ? causeMessages
          .map(dshHttpFailure)
          .find(
            (item) =>
              item && (httpStatus === undefined || item.status === httpStatus),
          )
      : undefined;
  const npmOutput =
    code === 'ENV_IMAGE_BUILD_FAILED' || code === 'ENV_RUNTIME_INSTALL_FAILED';
  const reason =
    model ??
    transport ??
    response?.reason ??
    (httpStatus !== undefined && httpStatus >= 400
      ? httpReason(httpStatus)
      : undefined) ??
    networkReasons.get(details?.networkReason ?? '') ??
    causeMessages
      .map((message) => textTransportReason(message, npmOutput))
      .find(Boolean);
  const summary =
    reason ??
    (registered
      ? `SDK hint · ${ERROR_CODES[code].hint} ${diagnosticsHint}`
      : diagnosticsHint);
  const exitCode = details?.exitCode;
  const responseStatus = httpStatus ?? response?.status;
  const verboseNotice = [
    phase && `phase ${phase}`,
    responseStatus !== undefined && `HTTP ${responseStatus}`,
    Number.isSafeInteger(exitCode) && `process exit ${exitCode}`,
    attemptId && attemptIdPattern.test(attemptId) && `attempt ${attemptId}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    notice: `${registered ? code : 'evaluator issue'} · ${summary}`,
    ...(verboseNotice ? { verboseNotice } : {}),
  };
}
