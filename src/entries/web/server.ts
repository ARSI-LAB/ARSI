import { ObservationQueries } from '../../runtime/services/observation.js';
import { registerObservationRoutes } from './observation.js';
import { errorText } from '../../shared/errors.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Manager } from '../../runtime/manager/index.js';
import type { Registry } from '../../runtime/registry/index.js';
import type { JsonObject } from '../../contracts/index.js';
export interface ServerRuntime {
  manager: Pick<
    Manager,
    'list' | 'get' | 'run' | 'cancel' | 'facts' | 'artifacts'
  >;
  registry: Pick<Registry, 'catalog'>;
}
/** HTTP adapts Runtime calls; jobs survive the lifetime of an individual browser request. */
export async function createServer(
  runtime: ServerRuntime,
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 65536,
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const jobs = new Map<string, Promise<unknown>>(),
    starting = new Map<string, JsonObject>();
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? 'localhost';
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return reply.code(403).send({ error: 'Invalid host' });
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
      return reply.code(403).send({ error: 'Loopback host required' });
    const origin = request.headers.origin;
    if (
      (origin !== undefined && origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      return reply.code(403).send({ error: 'Origin rejected' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number; code?: string };
    reply
      .code(failure.statusCode ?? (failure.code === 'ENOENT' ? 404 : 400))
      .send({ error: failure.message });
  });
  registerObservationRoutes(
    app,
    new ObservationQueries(runtime.manager.facts, runtime.manager.artifacts),
  );
  app.get('/api/catalog', async () => runtime.registry.catalog());
  app.get('/api/experiments', async () => {
    const entries = await runtime.manager.list();
    const ids = new Set(entries.map((item) => item.id));
    return [
      ...entries,
      ...[...starting.values()].filter((item) => !ids.has(item.id)),
    ];
  });
  app.get<{ Params: { id: string } }>(
    '/api/experiments/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      try {
        return await runtime.manager.get(request.params.id);
      } catch (error) {
        const pending = starting.get(request.params.id);
        if (pending) return pending;
        throw error;
      }
    },
  );
  app.post<{ Body: { recipePath: string; id?: string; resume?: boolean } }>(
    '/api/experiments',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            recipePath: { type: 'string', minLength: 1 },
            id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
            resume: { type: 'boolean' },
          },
          required: ['recipePath'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const id = request.body.id ?? `experiment-${randomUUID()}`;
      if (jobs.has(id))
        return reply.code(409).send({ error: 'Experiment already running' });
      if (request.body.resume && !request.body.id)
        return reply
          .code(400)
          .send({ error: 'Resume requires an experiment ID' });
      starting.set(id, { id, status: 'starting' });
      const job = runtime.manager.run(request.body.recipePath, {
        id,
        resume: request.body.resume,
      });
      jobs.set(id, job);
      void job
        .catch((error) => {
          starting.set(id, {
            id,
            status: 'failed',
            error: errorText(error),
          });
        })
        .finally(() => jobs.delete(id));
      return reply.code(202).send({ id, status: 'accepted' });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/experiments/:id/cancel',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      runtime.manager.cancel(request.params.id);
      return { id: request.params.id, cancellationRequested: true };
    },
  );
  app.addHook('onClose', async () => {
    for (const id of jobs.keys())
      try {
        runtime.manager.cancel(id);
      } catch {}
    await Promise.allSettled(jobs.values());
  });
  const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
  try {
    await access(publicDirectory);
    await app.register(fastifyStatic, { root: publicDirectory });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    app.get('/', async (_request, reply) =>
      reply
        .type('text/plain')
        .send('RSI API is ready. Build the package to load the web interface.'),
    );
  }
  return app;
}
