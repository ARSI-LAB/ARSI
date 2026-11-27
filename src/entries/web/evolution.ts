import { validate } from '../../shared/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Manager } from '../../runtime/manager/index.js';
import type { ObservationQueries } from '../../runtime/services/observation.js';

/** Verify experiment ownership before exposing a snapshot or mutating its destination. */
export function registerEvolutionRoutes(
  app: FastifyInstance,
  manager: Pick<Manager, 'reflection' | 'memory'>,
  queries: ObservationQueries,
  publicReadOnly = false,
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
  const snapshotParams = {
    ...params,
    properties: { id: identifier, ref: identifier },
    required: ['id', 'ref'],
  };
  const destination = {
    type: 'object',
    properties: { targetDir: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
  const previewQuery = {
    ...destination,
    properties: {
      ...destination.properties,
      inspection: { type: 'integer', minimum: 0 },
    },
  };
  type Params = { id: string; ref: string };
  type Destination = { targetDir?: string };
  for (const kind of ['revisions', 'memories'] as const) {
    app.get<{ Params: { id: string } }>(
      `/api/observation/experiments/:id/${kind}`,
      { schema: { params } },
      (request) => queries.evolution(request.params.id, kind),
    );
    const service = kind === 'memories' ? 'memory' : 'reflection';
    const assertOwnership = ({ id, ref }: Params) =>
      kind === 'memories'
        ? queries.assertMemory(id, ref)
        : queries.assertRevision(id, ref);
    app.get<{ Params: Params; Querystring: Destination }>(
      `/api/observation/experiments/:id/${kind}/:ref/application`,
      { schema: { params: snapshotParams, querystring: previewQuery } },
      async ({ params, query }) => {
        await assertOwnership(params);
        if (publicReadOnly)
          return {
            applicationAllowed: false,
            restrictions: [
              'Local file changes are unavailable on a public read-only dashboard.',
            ],
            changes: [],
          };
        return queries.applicationPreview(
          params.id,
          await manager[service]().show(params.ref, { to: query.targetDir }),
        );
      },
    );
    app.post<{ Params: Params; Body?: Destination }>(
      `/api/experiments/:id/${kind}/:ref/apply`,
      { schema: { params: snapshotParams } },
      async ({ params, body }) => {
        if (body !== undefined)
          validate(destination, body, 'application destination');
        await assertOwnership(params);
        const result = await manager[service]().apply(params.ref, {
          to: body?.targetDir,
        });
        return { status: result.status };
      },
    );
  }
}
