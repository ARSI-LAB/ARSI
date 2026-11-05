import type { FastifyInstance } from 'fastify';
import type { ObservationQueries } from '../../runtime/services/observation.js';

/** Additive, GET-only routes. Existing control endpoints retain their contracts. */
export function registerObservationRoutes(
  app: FastifyInstance,
  queries: ObservationQueries,
): void {
  app.get('/api/observation/source', () => queries.source());
  const id = {
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    maxLength: 256,
  };
  const pagination = {
    type: 'object',
    properties: {
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  };
  const params = {
    type: 'object',
    properties: { id },
    required: ['id'],
    additionalProperties: false,
  };
  type Window = { offset?: number; limit?: number };
  app.get<{ Querystring: Window }>(
    '/api/observation/experiments',
    { schema: { querystring: pagination } },
    (request) => queries.experiments(request.query.offset, request.query.limit),
  );
  app.get<{ Params: { id: string } }>(
    '/api/observation/experiments/:id',
    { schema: { params } },
    (request) => queries.overview(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    '/api/observation/experiments/:id/details',
    { schema: { params } },
    (request) => queries.details(request.params.id),
  );
  app.get<{
    Params: { id: string; ref: string };
    Querystring: Window & { path?: string };
  }>(
    '/api/observation/experiments/:id/artifacts/:ref',
    {
      schema: {
        params: {
          ...params,
          properties: {
            id,
            ref: { type: 'string', pattern: '^artifact:[a-f0-9]{64}$' },
          },
          required: ['id', 'ref'],
        },
        querystring: {
          ...pagination,
          properties: {
            ...pagination.properties,
            path: { type: 'string', minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    (request) =>
      queries.artifact(
        request.params.id,
        request.params.ref,
        request.query.path,
        request.query.offset,
        request.query.limit,
      ),
  );
  for (const resource of ['calls', 'candidates'] as const) {
    app.get<{ Params: { id: string }; Querystring: Window }>(
      `/api/observation/experiments/:id/${resource}`,
      { schema: { params, querystring: pagination } },
      (request) =>
        queries[resource](
          request.params.id,
          request.query.offset,
          request.query.limit,
        ),
    );
  }
  app.get<{ Params: { id: string }; Querystring: Window }>(
    '/api/observation/experiments/:id/metric-observations',
    { schema: { params, querystring: pagination } },
    (request) =>
      queries.metricRecords(
        request.params.id,
        request.query.offset,
        request.query.limit,
      ),
  );
  app.get<{
    Params: { id: string };
    Querystring: Window & { candidate?: string };
  }>(
    '/api/observation/experiments/:id/measurements',
    {
      schema: {
        params,
        querystring: {
          ...pagination,
          properties: { ...pagination.properties, candidate: id },
        },
      },
    },
    (request) =>
      queries.measurements(
        request.params.id,
        request.query.offset,
        request.query.limit,
        request.query.candidate,
      ),
  );
  app.get<{ Params: { id: string; callId: string } }>(
    '/api/observation/experiments/:id/calls/:callId',
    {
      schema: {
        params: {
          ...params,
          properties: { id, callId: id },
          required: ['id', 'callId'],
        },
      },
    },
    (request) => queries.callDetail(request.params.id, request.params.callId),
  );
  app.get<{ Params: { id: string; callId: string } }>(
    '/api/observation/experiments/:id/calls/:callId/instructions',
    {
      schema: {
        params: {
          ...params,
          properties: { id, callId: id },
          required: ['id', 'callId'],
        },
      },
    },
    (request) =>
      queries.callInstructions(request.params.id, request.params.callId),
  );
  app.get<{ Params: { id: string; callId: string }; Querystring: Window }>(
    '/api/observation/experiments/:id/calls/:callId/trace',
    {
      schema: {
        params: {
          ...params,
          properties: { id, callId: id },
          required: ['id', 'callId'],
        },
        querystring: pagination,
      },
    },
    (request) =>
      queries.callTrace(
        request.params.id,
        request.params.callId,
        request.query.offset,
        request.query.limit,
      ),
  );
}
