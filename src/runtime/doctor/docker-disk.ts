import type { JsonObject } from '../../contracts/index.js';
import type { PreparedTask } from 'ember-evaluator';
import { object } from '../../shared/json.js';
import { errorText } from '../../shared/errors.js';
import {
  probeDockerDisk,
  dockerLayersAreLocal,
  DockerDiskProbeFailure,
  type DockerDiskProbeResult,
} from './docker-disk-probe.js';
import {
  collectDockerStoragePlan,
  calculateDockerDiskRequirements,
  type DockerImageObservation,
} from './docker-disk-requirements.js';
import type { DoctorContext } from './types.js';
import type { runCommand } from './process.js';

type Command = typeof runCommand;

function nativePlatform(info: JsonObject): string | undefined {
  if (info.OSType !== 'linux') return undefined;
  if (['amd64', 'x86_64', 'x64'].includes(String(info.Architecture)))
    return 'linux/amd64';
  if (['arm64', 'aarch64'].includes(String(info.Architecture)))
    return 'linux/arm64';
  return undefined;
}

/** Inspect capabilities once, matching the SDK's old-client/server fallback. */
function platformCommand(command: Command): Command {
  let supported: Promise<boolean> | undefined;
  return async (executable, args, options) => {
    const index = args.indexOf('--platform');
    if (args[0] !== 'image' || args[1] !== 'inspect' || index < 0)
      return command(executable, args, options);
    supported ??= command(
      executable,
      ['version', '--format', '{{.Client.APIVersion}} {{.Server.APIVersion}}'],
      options,
    )
      .then(({ stdout }) => {
        const versions = stdout.trim().split(/\s+/);
        return (
          versions.length === 2 &&
          versions.every((value) => {
            if (!/^\d+\.\d+$/.test(value)) return false;
            const [major, minor] = value.split('.').map(Number);
            return major! > 1 || (major === 1 && minor! >= 49);
          })
        );
      })
      .catch(() => {
        supported = undefined;
        options.signal.throwIfAborted();
        // A single-variant local store can still be inspected and its returned
        // architecture validated without platform selection. Never pull a variant.
        return false;
      });
    return command(
      executable,
      (await supported)
        ? args
        : args.filter(
            (_value, position) => position !== index && position !== index + 1,
          ),
      options,
    );
  };
}

/** Capacity is an observation and a conservative admission floor, never a quota. */
export async function checkDockerDiskCapacity(
  ctx: DoctorContext,
  command: Command,
  executable: string,
  info: JsonObject,
  options: {
    tasks: readonly PreparedTask[];
    metadataComplete: boolean;
    config: JsonObject;
    gatewayImage: string;
  },
): Promise<void> {
  const native = nativePlatform(info);
  const configured = options.config.platform;
  const platform =
    configured === 'linux/amd64' || configured === 'linux/arm64'
      ? configured
      : (native ?? 'unknown');
  const imageOverrides = Object.fromEntries(
    Object.entries(object(options.config.imageOverrides ?? {})).map(
      ([key, value]) => {
        if (typeof value !== 'string')
          throw new Error(
            `environment.config.imageOverrides.${key}: expected image reference`,
          );
        return [key, value];
      },
    ),
  );
  const plan = collectDockerStoragePlan({
    tasks: options.tasks,
    platform,
    gatewayImage: options.gatewayImage,
    metadataComplete: options.metadataComplete,
    ...(typeof options.config.image === 'string'
      ? { defaultImage: options.config.image }
      : {}),
    imageOverrides,
  });
  const selectedCommand = platformCommand(command);
  let observed: DockerDiskProbeResult = { filesystems: [], unknownReasons: [] };
  let probeError: unknown;
  try {
    observed = await probeDockerDisk(selectedCommand, executable, info, {
      image: options.gatewayImage,
      platform: native ?? platform,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
    });
  } catch (error) {
    ctx.signal.throwIfAborted();
    probeError = error;
    if (error instanceof DockerDiskProbeFailure) observed = error.observations;
    observed.unknownReasons.push(errorText(error));
  }
  const spaceDetails = object({
    daemon: {
      name: info.Name ?? null,
      dockerRootDir: info.DockerRootDir ?? null,
      storageDriver: info.Driver ?? null,
    },
    filesystems: observed.filesystems,
    unknownReasons: observed.unknownReasons,
  });
  if (probeError !== undefined)
    await ctx.check(
      'docker-disk-space',
      async () => {
        throw probeError;
      },
      { details: spaceDetails },
    );
  else if (!observed.filesystems.length)
    ctx.unchecked(
      'docker-disk-space',
      observed.unknownReasons.join(' ') ||
        'Daemon storage availability could not be measured.',
      spaceDetails,
    );
  else
    await ctx.check('docker-disk-space', async () => {}, {
      details: spaceDetails,
    });

  const images: DockerImageObservation[] = [];
  const inventoryUnknowns: string[] = [];
  const inventorySignal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(30000),
  ]);
  for (const image of plan.images) {
    try {
      const result = await selectedCommand(
        executable,
        ['image', 'inspect', '--platform', image.platform, image.reference],
        { signal: inventorySignal },
      );
      const inspection: unknown = JSON.parse(result.stdout);
      images.push({ ...image, inspection });
    } catch (error) {
      ctx.signal.throwIfAborted();
      images.push({ ...image, inspection: null });
      inventoryUnknowns.push(
        `${image.platform} ${image.reference}: cached layer inspection unavailable: ${errorText(error)}`,
      );
      if (inventorySignal.aborted) break;
    }
  }
  const requirements = calculateDockerDiskRequirements({ plan, images });
  if (!dockerLayersAreLocal(info)) {
    requirements.pullBytes = null;
    requirements.unpackBytes = null;
    requirements.unknowns.push(
      'Cached image metadata does not prove that layer content is local for this Docker storage driver.',
    );
  }
  const unknownReasons = [
    ...new Set([
      ...observed.unknownReasons,
      ...requirements.unknowns,
      ...inventoryUnknowns,
    ]),
  ];
  const shortfalls: JsonObject[] = [];
  for (const filesystem of observed.filesystems) {
    if (
      filesystem.roles.includes('container-writable') &&
      requirements.runtimeKnownLowerBoundBytes > filesystem.availableBytes
    )
      shortfalls.push({
        scope: 'declared-task-runtime',
        path: filesystem.path,
        availableBytes: filesystem.availableBytes,
        knownRequiredBytes: requirements.runtimeKnownLowerBoundBytes,
        shortfallBytes:
          requirements.runtimeKnownLowerBoundBytes - filesystem.availableBytes,
      });
  }
  if (
    !observed.filesystems.some((filesystem) =>
      filesystem.roles.includes('container-writable'),
    )
  )
    unknownReasons.push(
      'The daemon filesystem for task writable layers is unmeasured.',
    );
  if (
    !observed.filesystems.some((filesystem) =>
      filesystem.roles.includes('image-store'),
    )
  )
    unknownReasons.push(
      'The image content-store filesystem has not been located; other filesystem observations cannot substitute for it.',
    );
  const details = object({
    ...spaceDetails,
    requirements,
    shortfalls,
    unknownReasons,
  });
  if (
    shortfalls.length ||
    (probeError !== undefined &&
      /ENOSPC|no space left on device/i.test(errorText(probeError)))
  )
    await ctx.check(
      'docker-disk-capacity',
      async () => {
        throw new Error(
          shortfalls.length
            ? shortfalls
                .map(
                  (item) =>
                    `${item.scope} on ${item.path}: available ${item.availableBytes} bytes, known required ${item.knownRequiredBytes} bytes, gap ${item.shortfallBytes} bytes.`,
                )
                .join(' ')
            : `Docker daemon reported a storage shortage: ${errorText(probeError)} Available bytes and gap could not be measured.`,
        );
      },
      { details },
    );
  else if (unknownReasons.length)
    ctx.unchecked(
      'docker-disk-capacity',
      `Disk capacity is not established. ${unknownReasons.join(' ')}`,
      details,
    );
  else await ctx.check('docker-disk-capacity', async () => {}, { details });
}
