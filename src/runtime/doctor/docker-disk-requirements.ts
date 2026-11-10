import type { PreparedTask } from 'ember-evaluator';

export interface DockerImageRequest {
  reference: string;
  platform: string;
  roles: string[];
}

export interface DockerStoragePlan {
  images: DockerImageRequest[];
  pullBytes: number | null;
  unpackBytes: number | null;
  buildBytes: number | null;
  runtimeBytes: number | null;
  runtimeKnownLowerBoundBytes: number;
  unknowns: string[];
}

export interface DockerImageObservation {
  reference: string;
  platform: string;
  /** Parsed docker image inspect output, or null when the target is unavailable. */
  inspection: unknown | null;
}

export interface CachedDockerImage {
  id: string;
  platform: string;
  layers: string[] | null;
  /** Observed image Size includes shared layers; it is never incremental demand. */
  sizeBytes: number | null;
}

export interface DockerImageStorageObservation extends DockerImageRequest {
  cached: boolean;
  cachedLayerCount: number | null;
  imageSizeBytes: number | null;
}

export interface DockerDiskRequirements {
  pullBytes: number | null;
  unpackBytes: number | null;
  buildBytes: number | null;
  runtimeBytes: number | null;
  /** Only confirmed incremental components contribute to the admission floor. */
  knownRequiredBytes: number;
  runtimeKnownLowerBoundBytes: number;
  requestedImageCount: number;
  cachedImageCount: number;
  cachedLayerCount: number;
  images: DockerImageStorageObservation[];
  unknowns: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function byteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Docker's selected ARM64 platform commonly reports the default v8 variant. */
function imagePlatform(image: Record<string, unknown>): string | undefined {
  if (typeof image.Os !== 'string' || typeof image.Architecture !== 'string')
    return undefined;
  const variant = typeof image.Variant === 'string' ? image.Variant : '';
  const base = `${image.Os}/${image.Architecture}`;
  return variant && !(base === 'linux/arm64' && variant === 'v8')
    ? `${base}/${variant}`
    : base;
}

/** A cached foreign-platform image cannot satisfy a selected target. */
export function readCachedDockerImage(
  inspection: unknown,
  platform: string,
): CachedDockerImage | null {
  const entries = Array.isArray(inspection) ? inspection : [inspection];
  for (const entry of entries) {
    const image = record(entry);
    if (
      !image ||
      imagePlatform(image) !== platform ||
      typeof image.Id !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(image.Id)
    )
      continue;
    const rootfs = record(image.RootFS);
    const rawLayers = rootfs?.Layers;
    const layers =
      Array.isArray(rawLayers) &&
      rawLayers.every(
        (layer): layer is string =>
          typeof layer === 'string' && /^sha256:[a-f0-9]{64}$/.test(layer),
      )
        ? [...new Set(rawLayers)]
        : null;
    return {
      id: image.Id,
      platform,
      layers,
      sizeBytes: byteCount(image.Size),
    };
  }
  return null;
}

/** Declared storage is a planning request; the SDK does not enforce a disk quota. */
function storageBytes(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?)(?:i?b)?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const exponent = 'bkmgtpe'.indexOf(match[2].toLowerCase() || 'b');
  const bytes = Number(match[1]) * 1024 ** exponent;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/** Enumerate effective main/service images without preparing or materializing them. */
export function collectDockerStoragePlan(options: {
  tasks: readonly PreparedTask[];
  platform: string;
  gatewayImage: string;
  metadataComplete: boolean;
  defaultImage?: string;
  imageOverrides?: Readonly<Record<string, string>>;
}): DockerStoragePlan {
  const requests = new Map<string, DockerImageRequest>();
  const unknowns = new Set<string>();
  const override = (reference: string): string =>
    options.imageOverrides && Object.hasOwn(options.imageOverrides, reference)
      ? options.imageOverrides[reference]!
      : reference;
  const add = (reference: string, platform: string, role: string): void => {
    const key = JSON.stringify([platform, reference]);
    const request = requests.get(key);
    if (request) {
      if (!request.roles.includes(role)) request.roles.push(role);
    } else requests.set(key, { reference, platform, roles: [role] });
  };
  let runtimeKnownLowerBoundBytes = 0;
  let mainEnvironments = 0;
  let imageDemandComplete = options.metadataComplete;
  const environment = (spec: PreparedTask['solveEnv'], role: string): void => {
    mainEnvironments++;
    const platform = spec.platform ?? options.platform;
    add(options.gatewayImage, platform, `${role}.sdk-runtime`);
    const reference =
      spec.image ?? (!spec.build ? options.defaultImage : undefined);
    if (reference) add(override(reference), platform, role);
    else if (spec.build) {
      imageDemandComplete = false;
      unknowns.add(`${role}: task image build and unpack sizes are unknown.`);
    } else {
      imageDemandComplete = false;
      unknowns.add(`${role}: the effective base image is unavailable.`);
    }
    // materializeObserved always calls DockerRuntime.prepare, even for runtime=[].
    // A raw base image is not proof that the versioned derived runtime is cached.
    unknowns.add(`${role}: SDK derived runtime image build space is unknown.`);
    if (spec.installation)
      unknowns.add(
        `${role}: SDK solver installation and derived image build space is unknown.`,
      );
    const storage = spec.resources?.storage;
    if (storage === undefined)
      unknowns.add(
        `${role}: resources.storage is undeclared; runtime disk growth is unknown.`,
      );
    else {
      const bytes = storageBytes(storage);
      if (bytes === null)
        unknowns.add(
          `${role}: resources.storage ${JSON.stringify(storage)} cannot be converted to a safe byte count.`,
        );
      else
        runtimeKnownLowerBoundBytes = Math.max(
          runtimeKnownLowerBoundBytes,
          bytes,
        );
    }
    for (const [name, service] of Object.entries(spec.services ?? {})) {
      if (name === 'main') continue;
      const serviceRole = `${role}.service.${name}`;
      if (service.image) add(override(service.image), platform, serviceRole);
      else if (service.build) {
        imageDemandComplete = false;
        unknowns.add(
          `${serviceRole}: service image build and unpack sizes are unknown.`,
        );
      } else {
        imageDemandComplete = false;
        unknowns.add(
          `${serviceRole}: the effective service image is unavailable.`,
        );
      }
      unknowns.add(`${serviceRole}: runtime disk growth is undeclared.`);
    }
  };
  for (const task of options.tasks) {
    environment(task.solveEnv, `${task.input.id}.solve`);
    if (task.steps?.length) {
      // The executor reuses the top-level solve environment across every step.
      for (const step of task.steps)
        if (step.task.verifyEnv)
          environment(
            step.task.verifyEnv,
            `${task.input.id}.step.${step.name}.verify`,
          );
    } else if (task.verifyEnv)
      environment(task.verifyEnv, `${task.input.id}.verify`);
  }
  if (!mainEnvironments) add(options.gatewayImage, options.platform, 'gateway');
  if (!options.metadataComplete)
    unknowns.add(
      'Selected task metadata is incomplete; additional image, build and runtime demand is unknown.',
    );
  if (mainEnvironments)
    unknowns.add(
      'Runtime disk demand retains the largest single-environment declaration as a lower bound; concurrent jobs, solve/verify overlap, transfers and unbounded writes are not an exact peak estimate.',
    );
  return {
    images: [...requests.values()],
    pullBytes: imageDemandComplete ? 0 : null,
    unpackBytes: imageDemandComplete ? 0 : null,
    buildBytes: mainEnvironments || !options.metadataComplete ? null : 0,
    runtimeBytes: mainEnvironments || !options.metadataComplete ? null : 0,
    runtimeKnownLowerBoundBytes,
    unknowns: [...unknowns],
  };
}

/** Cache-only observations cannot establish missing layers' compressed/unpacked sizes. */
export function calculateDockerDiskRequirements(options: {
  plan: DockerStoragePlan;
  images: readonly DockerImageObservation[];
}): DockerDiskRequirements {
  const unknowns = new Set(options.plan.unknowns);
  const cachedImages = new Set<string>();
  const cachedLayers = new Set<string>();
  let allCached = true;
  const images = options.plan.images.map(
    (request): DockerImageStorageObservation => {
      const observation = options.images.find(
        (image) =>
          image.reference === request.reference &&
          image.platform === request.platform,
      );
      const cached = readCachedDockerImage(
        observation?.inspection,
        request.platform,
      );
      if (!cached) {
        allCached = false;
        unknowns.add(
          `${request.platform} ${request.reference}: target image cache is unconfirmed; incremental pull and unpack sizes are unknown.`,
        );
      } else {
        cachedImages.add(JSON.stringify([cached.platform, cached.id]));
        if (cached.layers === null) {
          allCached = false;
          unknowns.add(
            `${request.platform} ${request.reference}: cached layer inventory is unavailable; incremental image storage is unconfirmed.`,
          );
        } else
          for (const layer of cached.layers)
            cachedLayers.add(JSON.stringify([cached.platform, layer]));
      }
      return {
        ...request,
        cached: cached !== null,
        cachedLayerCount: cached?.layers?.length ?? null,
        imageSizeBytes: cached?.sizeBytes ?? null,
      };
    },
  );
  const pullBytes = allCached ? options.plan.pullBytes : null;
  const unpackBytes = allCached ? options.plan.unpackBytes : null;
  return {
    pullBytes,
    unpackBytes,
    buildBytes: options.plan.buildBytes,
    runtimeBytes: options.plan.runtimeBytes,
    // Existing image Size is not new demand and shared layers must not be summed.
    // With cache-only inspection the confirmed nonzero floor is declared runtime.
    knownRequiredBytes: options.plan.runtimeKnownLowerBoundBytes,
    runtimeKnownLowerBoundBytes: options.plan.runtimeKnownLowerBoundBytes,
    requestedImageCount: options.plan.images.length,
    cachedImageCount: cachedImages.size,
    cachedLayerCount: cachedLayers.size,
    images,
    unknowns: [...unknowns],
  };
}
