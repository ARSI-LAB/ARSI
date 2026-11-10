import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { runCommand } from './process.js';

export type DockerDiskRole =
  | 'container-writable'
  | 'docker-root'
  | 'image-store';

export type DockerDiskFilesystem = {
  path: string;
  availableBytes: number;
  totalBytes: number;
  filesystemId: string;
  roles: DockerDiskRole[];
  source: 'daemon-container-statfs';
};

export type DockerDiskProbeResult = {
  filesystems: DockerDiskFilesystem[];
  unknownReasons: string[];
};

/** Operational faults retain completed measurements without inventing missing quantities. */
export class DockerDiskProbeFailure extends Error {
  readonly observations: DockerDiskProbeResult;

  constructor(
    message: string,
    observations: DockerDiskProbeResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.observations = structuredClone(observations);
  }
}

type Command = typeof runCommand;

type ProbePath = { path: string; label: string; roles: DockerDiskRole[] };

class DiskProbeContainerFailure extends Error {
  constructor(
    message: string,
    readonly observations: DockerDiskProbeResult | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// statfs runs in a container on the selected daemon, including a remote Engine or
// Docker Desktop VM. The CLI host's filesystem is never used as a substitute.
const statfsScript = `
void (async () => {
const fs = require('node:fs');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const filesystems = [], unknownReasons = [];
for (const item of JSON.parse(input)) {
  try {
    if (item.path !== '/' && (fs.lstatSync(item.path).isSymbolicLink() || fs.realpathSync(item.path) !== item.path))
      throw new Error('Storage path is a symlink or escapes its daemon-host bind; its filesystem cannot be identified safely');
    const stats = fs.statfsSync(item.path, { bigint: true });
    filesystems.push({ path: item.label, availableBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize), filesystemId: String(fs.statSync(item.path, { bigint: true }).dev),
      roles: item.roles, source: 'daemon-container-statfs' });
  } catch (error) {
    const storageFailure = error.code === 'ENOSPC' || /no space left on device/i.test(error.message);
    unknownReasons.push((storageFailure ? 'ENOSPC: ' : '') + 'Cannot measure daemon filesystem ' + item.label + ': ' + error.message);
    if (storageFailure) break;
  }
}
console.log(JSON.stringify({ filesystems, unknownReasons }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noSpace(error: unknown): boolean {
  return /\bENOSPC\b|no space left on device/i.test(message(error));
}

function parseResult(text: string): DockerDiskProbeResult {
  const result = object(JSON.parse(text), 'Docker disk probe');
  if (
    !Array.isArray(result.filesystems) ||
    !Array.isArray(result.unknownReasons)
  )
    throw new Error('Docker disk probe returned no filesystem observations');
  const roles: readonly string[] = [
    'container-writable',
    'docker-root',
    'image-store',
  ];
  const filesystems: DockerDiskFilesystem[] = result.filesystems.map(
    (entry) => {
      const item = object(entry, 'Docker disk filesystem');
      if (
        typeof item.path !== 'string' ||
        typeof item.availableBytes !== 'number' ||
        !Number.isSafeInteger(item.availableBytes) ||
        item.availableBytes < 0 ||
        typeof item.totalBytes !== 'number' ||
        !Number.isSafeInteger(item.totalBytes) ||
        item.totalBytes < item.availableBytes ||
        typeof item.filesystemId !== 'string' ||
        !Array.isArray(item.roles) ||
        !item.roles.length ||
        !item.roles.every(
          (role) => typeof role === 'string' && roles.includes(role),
        ) ||
        item.source !== 'daemon-container-statfs'
      )
        throw new Error(
          'Docker disk probe returned invalid filesystem observations',
        );
      return {
        path: item.path,
        availableBytes: item.availableBytes,
        totalBytes: item.totalBytes,
        filesystemId: item.filesystemId,
        roles: item.roles.map((role) => {
          if (
            role === 'container-writable' ||
            role === 'docker-root' ||
            role === 'image-store'
          )
            return role;
          throw new Error(
            'Docker disk probe returned an unsupported filesystem role',
          );
        }),
        source: 'daemon-container-statfs',
      };
    },
  );
  const unknownReasons = result.unknownReasons.map((reason) => {
    if (typeof reason !== 'string')
      throw new Error('Docker disk probe returned an invalid diagnostic');
    return reason;
  });
  return { filesystems, unknownReasons };
}

async function cachedPlatform(
  command: Command,
  executable: string,
  image: string,
  platform: string,
  signal: AbortSignal,
): Promise<boolean> {
  let text: string;
  try {
    text = (
      await command(
        executable,
        ['image', 'inspect', '--platform', platform, image],
        { signal },
      )
    ).stdout;
  } catch (error) {
    signal.throwIfAborted();
    if (
      !/unknown flag.*platform|unknown shorthand flag.*platform/i.test(
        message(error),
      )
    )
      throw error;
    // Older clients cannot select an inspect platform; admit only a matching
    // platform config from their local image store. Neither inspect can pull.
    text = (await command(executable, ['image', 'inspect', image], { signal }))
      .stdout;
  }
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) return false;
  const [os, architecture, variant] = platform.split('/');
  return raw.some((entry) => {
    const item = object(entry, 'Cached disk probe image');
    return (
      item.Os === os &&
      item.Architecture === architecture &&
      (variant === undefined || item.Variant === variant)
    );
  });
}

async function containerStatfs(
  command: Command,
  executable: string,
  options: { image: string; platform: string; signal: AbortSignal },
  paths: ProbePath[],
  root?: string,
): Promise<DockerDiskProbeResult> {
  const name = `rsi-doctor-disk-${randomUUID()}`;
  let observed: DockerDiskProbeResult | undefined;
  try {
    const result = await command(
      executable,
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--platform',
        options.platform,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--workdir',
        '/',
        ...(root === undefined
          ? []
          : [
              '--mount',
              `type=bind,source=${root},target=/doctor-docker-root,readonly`,
            ]),
        '--entrypoint',
        'node',
        '-i',
        options.image,
        '-e',
        statfsScript,
      ],
      { signal: options.signal, input: JSON.stringify(paths) },
    );
    observed = parseResult(result.stdout);
    const storageFailure = observed.unknownReasons.find(noSpace);
    if (storageFailure)
      throw new DiskProbeContainerFailure(storageFailure, observed);
    return observed;
  } finally {
    try {
      await command(executable, ['rm', '-f', name], {
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (!(error instanceof Error && /no such container/i.test(error.message)))
        throw new DiskProbeContainerFailure(
          `Doctor disk probe container cleanup failed: ${message(error)}`,
          observed,
          { cause: error },
        );
    }
  }
}

/** Recognize local storage semantics; daemon info may omit other lazy-pull configuration. */
export function dockerLayersAreLocal(info: JsonObject): boolean {
  const driver =
    typeof info.Driver === 'string' ? info.Driver.toLowerCase() : '';
  const status = JSON.stringify(info.DriverStatus ?? '').toLowerCase();
  const features = info.Features;
  const explicitLazyPull =
    features !== null &&
    typeof features === 'object' &&
    !Array.isArray(features) &&
    features['lazy-pull'] === true;
  return (
    info.OSType === 'linux' &&
    !explicitLazyPull &&
    !/nydus|overlaybd|soci|stargz/.test(`${driver} ${status}`) &&
    [
      'overlay2',
      'overlay',
      'overlayfs',
      'vfs',
      'btrfs',
      'zfs',
      'aufs',
      'devicemapper',
      'fuse-overlayfs',
    ].includes(driver)
  );
}

/** Read daemon-side capacity only; unknown image stores are not guessed from DockerRootDir. */
export async function probeDockerDisk(
  command: Command,
  executable: string,
  info: JsonObject,
  options: { image: string; platform: string; signal: AbortSignal },
): Promise<DockerDiskProbeResult> {
  options.signal.throwIfAborted();
  const result: DockerDiskProbeResult = { filesystems: [], unknownReasons: [] };
  const driver =
    typeof info.Driver === 'string' ? info.Driver.toLowerCase() : '';
  const status = JSON.stringify(info.DriverStatus ?? '').toLowerCase();
  if (info.OSType !== 'linux' || !options.platform.startsWith('linux/')) {
    result.unknownReasons.push(
      'Daemon-side disk probing requires a Linux daemon and Linux cached probe image.',
    );
    return result;
  }
  if (!dockerLayersAreLocal(info)) {
    result.unknownReasons.push(
      `The locality of layers for Docker storage driver ${driver || '(unknown)'} is not established (lazy-pulling or unrecognized storage configuration); no disk helper was started.`,
    );
    return result;
  }
  try {
    if (
      !(await cachedPlatform(
        command,
        executable,
        options.image,
        options.platform,
        options.signal,
      ))
    ) {
      result.unknownReasons.push(
        `The disk probe image is not cached for target platform ${options.platform}; no image was fetched.`,
      );
      return result;
    }
  } catch (error) {
    options.signal.throwIfAborted();
    if (noSpace(error))
      throw new DockerDiskProbeFailure(message(error), result, {
        cause: error,
      });
    result.unknownReasons.push(
      `The cached disk probe image could not be resolved for ${options.platform}: ${message(error)} No image was fetched.`,
    );
    return result;
  }
  const measure = async (paths: ProbePath[], root?: string): Promise<void> => {
    try {
      const observed = await containerStatfs(
        command,
        executable,
        options,
        paths,
        root,
      );
      result.filesystems.push(...observed.filesystems);
      result.unknownReasons.push(...observed.unknownReasons);
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof DiskProbeContainerFailure) {
        if (error.observations) {
          result.filesystems.push(...error.observations.filesystems);
          result.unknownReasons.push(...error.observations.unknownReasons);
        }
        throw new DockerDiskProbeFailure(message(error), result, {
          cause: error,
        });
      }
      if (noSpace(error))
        throw new DockerDiskProbeFailure(message(error), result, {
          cause: error,
        });
      result.unknownReasons.push(
        `Daemon filesystem measurement is unavailable: ${message(error)}`,
      );
    }
  };
  // A container's own filesystem reports its writable-layer/snapshot capacity,
  // independently of whether the daemon permits a read-only host-path bind.
  await measure([
    { path: '/', label: 'container:/', roles: ['container-writable'] },
  ]);
  const root = typeof info.DockerRootDir === 'string' ? info.DockerRootDir : '';
  if (!root.startsWith('/') || root === '/' || /[,\r\n\0]/.test(root)) {
    result.unknownReasons.push(
      'DockerRootDir is unavailable or cannot be safely bound for a daemon-side measurement.',
    );
    return result;
  }
  const containerd = status.includes('io.containerd.snapshotter.v1');
  const classic =
    !containerd && ['overlay2', 'overlay', 'vfs'].includes(driver);
  const paths: ProbePath[] = [
    { path: '/doctor-docker-root', label: root, roles: ['docker-root'] },
  ];
  if (classic)
    paths.push({
      path: `/doctor-docker-root/${driver}`,
      label: posix.join(root, driver),
      roles: ['image-store'],
    });
  else
    result.unknownReasons.push(
      containerd
        ? 'The containerd content store has a separately configurable storage path; DockerRootDir and container writable-layer observations do not locate its filesystem.'
        : `The image-store filesystem for Docker storage driver ${driver || '(unknown)'} could not be established.`,
    );
  await measure(paths, root);
  return result;
}
