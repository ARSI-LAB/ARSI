import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeContext } from '../../../contracts/index.js';
import { scanTree } from '../file-application/target.js';
import { publishDshUserLayer } from './publishers/dsh-user-layer.js';
import {
  assertDisjoint,
  inside,
  replaceDirectory,
} from './publishers/shared.js';
import type { GymBundlePublication, GymPublisher } from './schema.js';

export type { GymBundlePublication } from './schema.js';

const PUBLISH_LOCKS = new Map<string, Promise<unknown>>();

/**
 * Publish a materialized AgentBundle to the surface its Gym adapter reads.
 * This is the only seam evaluator.gym and release.gym share with a harness.
 */
export async function publishCandidate(
  publisher: GymPublisher | undefined,
  context: RuntimeContext,
  publication: GymBundlePublication,
): Promise<void> {
  if (publisher === undefined) return;
  assertBundleKind(publisher, publication.bundleKind);
  await scanTree(publication.directory);
  switch (publisher.kind) {
    case 'directory':
      return publishDirectory(publisher, context, publication);
    case 'dsh-user-layer': {
      const home = resolve(context.rootDirectory, publisher.dshHome);
      return serialized(join(home, publisher.profileName ?? 'headless'), () =>
        publishDshUserLayer(publisher, context, publication),
      );
    }
    case 'remote-http':
      return publishRemote(publisher, context, publication);
  }
}

/** @deprecated Use publishCandidate. */
export function activateCandidate(
  publisher: GymPublisher | undefined,
  context: RuntimeContext,
  candidateRef: string,
  directory: string,
  bundleDigest: string,
): Promise<void> {
  return publishCandidate(publisher, context, {
    candidateRef,
    directory,
    bundleDigest,
  });
}

function assertBundleKind(
  publisher: GymPublisher,
  bundleKind: string | undefined,
): void {
  if (bundleKind === undefined || publisher.bundleKinds === undefined) return;
  if (!publisher.bundleKinds.includes(bundleKind))
    throw new Error(
      `gym publisher ${publisher.kind} does not accept AgentBundle kind ${bundleKind}`,
    );
}

async function publishDirectory(
  publisher: Extract<GymPublisher, { kind: 'directory' }>,
  context: RuntimeContext,
  publication: GymBundlePublication,
): Promise<void> {
  const target = resolve(context.rootDirectory, publisher.directory);
  assertDisjoint(publication.directory, target);
  await serialized(target, () =>
    replaceDirectory(publication.directory, target, async (staging) => {
      if (publisher.manifestPath === undefined) return;
      const manifest = inside(staging, publisher.manifestPath);
      await mkdir(dirname(manifest), { recursive: true });
      await writeFile(
        manifest,
        `${JSON.stringify(publicationRecord(publication), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }),
  );
}

async function publishRemote(
  publisher: Extract<GymPublisher, { kind: 'remote-http' }>,
  context: RuntimeContext,
  publication: GymBundlePublication,
): Promise<void> {
  const token =
    publisher.tokenEnv === undefined
      ? undefined
      : process.env[publisher.tokenEnv];
  if (publisher.tokenEnv !== undefined && !token)
    throw new Error(
      `publish token environment variable ${publisher.tokenEnv} is unset`,
    );
  const response = await fetch(publisher.activateUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      candidate_id: publication.candidateRef,
      bundle_dir: publication.directory,
      candidate_digest: publication.bundleDigest,
    }),
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `candidate publication failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  let value: {
    ready?: unknown;
    candidate_id?: unknown;
    candidate_digest?: unknown;
  };
  try {
    value = JSON.parse(text) as typeof value;
  } catch (error) {
    throw new Error(
      `candidate publication returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    value.ready !== true ||
    value.candidate_id !== publication.candidateRef ||
    value.candidate_digest !== publication.bundleDigest
  )
    throw new Error(
      'candidate publication did not confirm the requested candidate digest',
    );
}

function publicationRecord(publication: GymBundlePublication) {
  return {
    candidate_id: publication.candidateRef,
    candidate_digest: publication.bundleDigest,
    ...(publication.bundleKind === undefined
      ? {}
      : { bundle_kind: publication.bundleKind }),
  };
}

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = PUBLISH_LOCKS.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  PUBLISH_LOCKS.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}
