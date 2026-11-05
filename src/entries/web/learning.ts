import type { FastifyInstance } from 'fastify';
import type { Manager } from '../../runtime/manager/index.js';
import type { ObservationQueries } from '../../runtime/services/observation.js';

/** Transport only: ownership checks precede the existing revision application boundary. */
export function registerLearningRoutes(
  app: FastifyInstance,
  manager: Pick<Manager, 'reflection'>,
  queries: ObservationQueries,
): void {
  const identifier = {
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    maxLength: 256,
  };
  const params = {
    type: 'object',
    properties: { id: identifier },
    required: ['id'],
    additionalProperties: false,
  };
  const revisionParams = {
    ...params,
    properties: { id: identifier, ref: identifier },
    required: ['id', 'ref'],
  };
  for (const kind of ['revisions', 'memories'] as const) {
    app.get<{ Params: { id: string } }>(
      `/api/observation/experiments/:id/${kind}`,
      { schema: { params } },
      (request) => queries.learning(request.params.id, kind),
    );
  }
  app.get<{ Params: { id: string; ref: string } }>(
    '/api/observation/experiments/:id/revisions/:ref/application',
    { schema: { params: revisionParams } },
    async (request) => {
      const { id, ref } = request.params;
      await queries.assertRevision(id, ref);
      return queries.applicationPreview(
        id,
        await manager.reflection().show(ref),
      );
    },
  );
  app.post<{ Params: { id: string; ref: string } }>(
    '/api/experiments/:id/revisions/:ref/apply',
    { schema: { params: revisionParams } },
    async (request) => {
      const { id, ref } = request.params;
      await queries.assertRevision(id, ref);
      const result = await manager.reflection().apply(ref);
      return { status: result.status };
    },
  );
}
