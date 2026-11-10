import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../src/contracts/json.js';
import { runCommand } from '../../src/runtime/doctor/process.js';
import {
  probeDockerDisk,
  dockerLayersAreLocal,
  DockerDiskProbeFailure,
  type DockerDiskFilesystem,
} from '../../src/runtime/doctor/docker-disk-probe.js';

type Command = typeof runCommand;
type Call = {
  executable: string;
  args: readonly string[];
  input?: string;
  signal: AbortSignal;
};

const image = 'node:fixture@sha256:cached';
const options = (): {
  image: string;
  platform: string;
  signal: AbortSignal;
} => ({
  image,
  platform: 'linux/amd64',
  signal: new AbortController().signal,
});
const info: JsonObject = {
  OSType: 'linux',
  Driver: 'overlay2',
  DockerRootDir: '/daemon-volume/docker',
};

function fakeCommand(
  respond?: (
    call: Call,
  ) => Promise<{ stdout: string; stderr: string } | undefined> | undefined,
): { command: Command; calls: Call[] } {
  const calls: Call[] = [];
  const command: Command = async (executable, args, commandOptions) => {
    const call = {
      executable,
      args,
      input: commandOptions.input,
      signal: commandOptions.signal,
    };
    calls.push(call);
    const custom = await respond?.(call);
    if (custom) return custom;
    if (args[0] === 'image')
      return {
        stdout: JSON.stringify([{ Os: 'linux', Architecture: 'amd64' }]),
        stderr: '',
      };
    if (args[0] === 'run') {
      const paths: {
        path: string;
        label: string;
        roles: DockerDiskFilesystem['roles'];
      }[] = JSON.parse(commandOptions.input ?? '[]');
      const filesystems = paths.map((entry) => ({
        path: entry.label,
        availableBytes: entry.roles.includes('container-writable')
          ? 12345
          : 67890,
        totalBytes: 100000,
        filesystemId: entry.roles.includes('container-writable')
          ? 'snapshot-device'
          : 'docker-device',
        roles: entry.roles,
        source: 'daemon-container-statfs',
      }));
      return {
        stdout: JSON.stringify({ filesystems, unknownReasons: [] }),
        stderr: '',
      };
    }
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error(`Unexpected disk probe command: ${args.join(' ')}`);
  };
  return { command, calls };
}

test('disk probe measures remote daemon writable and classic image-store filesystems without using the CLI host', async () => {
  const f = fakeCommand();
  const result = await probeDockerDisk(
    f.command,
    'remote-docker',
    info,
    options(),
  );
  assert.deepEqual(result.unknownReasons, []);
  assert.equal(
    result.filesystems.find((entry) =>
      entry.roles.includes('container-writable'),
    )?.availableBytes,
    12345,
  );
  assert.equal(
    result.filesystems.find((entry) => entry.roles.includes('image-store'))
      ?.path,
    '/daemon-volume/docker/overlay2',
  );
  assert.ok(f.calls.every((call) => call.executable === 'remote-docker'));
  const runs = f.calls.filter((call) => call.args[0] === 'run');
  assert.equal(runs.length, 2);
  for (const call of runs) {
    assert.ok(call.args.includes('--pull=never'));
    assert.ok(call.args.includes('--network=none'));
    assert.ok(call.args.includes('--read-only'));
    assert.ok(call.args.includes('--cap-drop=ALL'));
    assert.ok(!call.args.includes('--privileged'));
  }
  assert.ok(
    runs[1].args.includes(
      'type=bind,source=/daemon-volume/docker,target=/doctor-docker-root,readonly',
    ),
  );
  assert.equal(
    f.calls.filter((call) => call.args[0] === 'rm').length,
    runs.length,
  );
  assert.ok(
    !f.calls.some(
      (call) =>
        call.args.includes('pull') ||
        call.args.includes('build') ||
        call.args.includes('prune') ||
        call.args.includes('df'),
    ),
  );
});

test('Docker Desktop/containerd keeps measured values and does not invent a content-store path', async () => {
  const f = fakeCommand();
  const result = await probeDockerDisk(
    f.command,
    'docker',
    {
      ...info,
      OperatingSystem: 'Docker Desktop',
      Driver: 'overlayfs',
      DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
    },
    options(),
  );
  assert.equal(result.filesystems.length, 2);
  assert.ok(
    result.filesystems.some((entry) => entry.roles.includes('docker-root')),
  );
  assert.ok(
    result.filesystems.some((entry) =>
      entry.roles.includes('container-writable'),
    ),
  );
  assert.ok(
    !result.filesystems.some((entry) => entry.roles.includes('image-store')),
  );
  assert.match(
    result.unknownReasons.join(' '),
    /containerd content store.*separately configurable/,
  );
  assert.ok(
    !f.calls.some((call) =>
      call.args.some((arg) => arg.includes('/var/lib/containerd')),
    ),
  );
});

test('a denied daemon-root bind preserves independent writable-layer capacity and still cleans both containers', async () => {
  const f = fakeCommand(async (call) => {
    if (call.args.includes('--mount'))
      throw new Error('bind source permission denied');
    return undefined;
  });
  const result = await probeDockerDisk(f.command, 'docker', info, options());
  assert.equal(result.filesystems.length, 1);
  assert.deepEqual(result.filesystems[0].roles, ['container-writable']);
  assert.match(result.unknownReasons.join(' '), /permission denied/);
  assert.equal(f.calls.filter((call) => call.args[0] === 'rm').length, 2);
});

test('unavailable or wrong-platform cached helper images cause no container launch or image fetch', async () => {
  for (const missing of [true, false]) {
    const f = fakeCommand(async (call) => {
      if (call.args[0] !== 'image') return undefined;
      if (missing) throw new Error('No such image');
      return {
        stdout: JSON.stringify([{ Os: 'linux', Architecture: 'arm64' }]),
        stderr: '',
      };
    });
    const result = await probeDockerDisk(f.command, 'docker', info, options());
    assert.deepEqual(result.filesystems, []);
    assert.match(
      result.unknownReasons.join(' '),
      /No image was fetched|no image was fetched/,
    );
    assert.ok(f.calls.every((call) => call.args[0] === 'image'));
  }
});

test('known lazy-pulling snapshotters never start a helper even if an image name could be cached', async () => {
  for (const driver of ['stargz', 'nydus', 'overlaybd', 'soci']) {
    const f = fakeCommand();
    const result = await probeDockerDisk(
      f.command,
      'docker',
      { ...info, Driver: driver },
      options(),
    );
    assert.match(result.unknownReasons.join(' '), /lazy-pulling/);
    assert.equal(f.calls.length, 0);
  }
});

test('an explicit lazy-pull feature prevents helper startup and local-cache completeness claims', async () => {
  const f = fakeCommand();
  const lazy = { ...info, Features: { 'lazy-pull': true } };
  assert.equal(dockerLayersAreLocal(lazy), false);
  assert.equal(
    dockerLayersAreLocal({ ...info, Features: { 'lazy-pull': false } }),
    true,
  );
  assert.equal(
    dockerLayersAreLocal({
      ...info,
      DriverStatus: [['snapshotter', 'stargz']],
    }),
    false,
  );
  const result = await probeDockerDisk(f.command, 'docker', lazy, options());
  assert.match(result.unknownReasons.join(' '), /lazy-pulling/);
  assert.equal(f.calls.length, 0);
});

test('unavailable daemon path and non-Linux daemons remain unknown instead of measuring the CLI disk', async () => {
  const f = fakeCommand();
  const missingRoot = await probeDockerDisk(
    f.command,
    'docker',
    { ...info, DockerRootDir: '' },
    options(),
  );
  assert.equal(missingRoot.filesystems.length, 1);
  assert.match(missingRoot.unknownReasons.join(' '), /DockerRootDir/);
  const windows = fakeCommand();
  const unsupported = await probeDockerDisk(
    windows.command,
    'docker',
    { ...info, OSType: 'windows', DockerRootDir: 'C:\\docker' },
    options(),
  );
  assert.equal(unsupported.filesystems.length, 0);
  assert.equal(windows.calls.length, 0);
});

test('an unknown storage driver cannot implicitly fetch lazy layers through the disk helper', async () => {
  const f = fakeCommand();
  const result = await probeDockerDisk(
    f.command,
    'docker',
    { ...info, Driver: 'custom-snapshotter' },
    options(),
  );
  assert.equal(result.filesystems.length, 0);
  assert.match(
    result.unknownReasons.join(' '),
    /locality of layers.*not established/,
  );
  assert.equal(f.calls.length, 0);
});

test('cancellation uses an independent cleanup signal and stops further disk probes', async () => {
  const controller = new AbortController();
  const f = fakeCommand(async (call) => {
    if (call.args[0] === 'run') {
      const pending = new Promise<never>((_done, reject) =>
        call.signal.addEventListener(
          'abort',
          () => reject(call.signal.reason),
          { once: true },
        ),
      );
      controller.abort(new Error('cancel disk probe'));
      return pending;
    }
    if (call.args[0] === 'rm') {
      assert.equal(call.signal.aborted, false);
      return { stdout: '', stderr: '' };
    }
    return undefined;
  });
  await assert.rejects(
    probeDockerDisk(f.command, 'docker', info, {
      ...options(),
      signal: controller.signal,
    }),
    /cancel disk probe/,
  );
  assert.equal(f.calls.filter((call) => call.args[0] === 'run').length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === 'rm').length, 1);
});

test('disk helper cleanup failures are propagated rather than converted into unknown capacity', async () => {
  const f = fakeCommand(async (call) => {
    if (call.args[0] === 'rm') throw new Error('cleanup fixture failed');
    return undefined;
  });
  await assert.rejects(
    probeDockerDisk(f.command, 'docker', info, options()),
    /cleanup.*cleanup fixture failed/,
  );
});

test('confirmed daemon ENOSPC during image inspection or helper startup is a failure rather than unknown coverage', async () => {
  for (const stage of ['image', 'run']) {
    for (const reason of [
      'ENOSPC: cannot allocate daemon metadata',
      'no space left on device',
    ]) {
      const f = fakeCommand(async (call) => {
        if (call.args[0] === stage) throw new Error(reason);
        return undefined;
      });
      await assert.rejects(
        probeDockerDisk(f.command, 'docker', info, options()),
        /ENOSPC|no space left on device/,
      );
      assert.equal(
        f.calls.filter((call) => call.args[0] === 'rm').length,
        stage === 'run' ? 1 : 0,
      );
    }
  }
});

test('a later helper ENOSPC preserves the completed writable-filesystem measurement', async () => {
  const f = fakeCommand(async (call) => {
    if (call.args[0] === 'run' && call.args.includes('--mount'))
      throw new Error('ENOSPC: cannot create the daemon-root helper');
    return undefined;
  });
  await assert.rejects(
    probeDockerDisk(f.command, 'docker', info, options()),
    (error: unknown) => {
      assert.ok(error instanceof DockerDiskProbeFailure);
      assert.match(error.message, /ENOSPC/);
      assert.equal(error.observations.filesystems.length, 1);
      assert.equal(error.observations.filesystems[0].availableBytes, 12345);
      assert.deepEqual(error.observations.filesystems[0].roles, [
        'container-writable',
      ]);
      return true;
    },
  );
});

test('cleanup failure retains measurements completed in the container whose cleanup failed', async () => {
  let cleanups = 0;
  const f = fakeCommand(async (call) => {
    if (call.args[0] === 'rm' && ++cleanups === 2)
      throw new Error('cleanup fixture failed');
    return undefined;
  });
  await assert.rejects(
    probeDockerDisk(f.command, 'docker', info, options()),
    (error: unknown) => {
      assert.ok(error instanceof DockerDiskProbeFailure);
      assert.match(error.message, /cleanup fixture failed/);
      assert.equal(error.observations.filesystems.length, 3);
      assert.equal(
        error.observations.filesystems.find((entry) =>
          entry.roles.includes('image-store'),
        )?.availableBytes,
        67890,
      );
      return true;
    },
  );
});

test('ENOSPC while measuring a later path preserves earlier observations from the same helper', async () => {
  const f = fakeCommand(async (call) => {
    if (call.args[0] !== 'run' || !call.args.includes('--mount'))
      return undefined;
    return {
      stdout: JSON.stringify({
        filesystems: [
          {
            path: '/daemon-volume/docker',
            availableBytes: 10,
            totalBytes: 100,
            filesystemId: 'docker-device',
            roles: ['docker-root'],
            source: 'daemon-container-statfs',
          },
        ],
        unknownReasons: [
          'ENOSPC: Cannot measure daemon filesystem /daemon-volume/docker/overlay2',
        ],
      }),
      stderr: '',
    };
  });
  await assert.rejects(
    probeDockerDisk(f.command, 'docker', info, options()),
    (error: unknown) => {
      assert.ok(error instanceof DockerDiskProbeFailure);
      assert.equal(error.observations.filesystems.length, 2);
      assert.equal(
        error.observations.filesystems.find((entry) =>
          entry.roles.includes('docker-root'),
        )?.availableBytes,
        10,
      );
      return true;
    },
  );
});

test('disk helper script executes as Node CommonJS and returns actual statfs values', async () => {
  const f = fakeCommand(async (call) => {
    if (call.args[0] !== 'run') return undefined;
    // Replace only the external container transport; execute the bundled script
    // through real Node to cover its stdin, statfs and output protocol.
    const script = call.args[call.args.length - 1];
    return runCommand(process.execPath, ['-e', script], {
      signal: call.signal,
      input: call.input,
    });
  });
  const result = await probeDockerDisk(
    f.command,
    'docker',
    { ...info, DockerRootDir: '' },
    options(),
  );
  assert.equal(result.filesystems.length, 1);
  assert.ok(result.filesystems[0].availableBytes >= 0);
  assert.ok(
    result.filesystems[0].totalBytes >= result.filesystems[0].availableBytes,
  );
  assert.equal(result.filesystems[0].source, 'daemon-container-statfs');
});

test('a daemon image-store symlink cannot be mistaken for a helper-container filesystem', async () => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'doctor-disk-symlink-')),
  );
  try {
    const root = join(temporary, 'docker-root');
    const outside = join(temporary, 'outside-root');
    await mkdir(root);
    await mkdir(outside);
    await symlink(
      outside,
      join(root, 'overlay2'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const f = fakeCommand(async (call) => {
      if (call.args[0] !== 'run') return undefined;
      const paths: {
        path: string;
        label: string;
        roles: DockerDiskFilesystem['roles'];
      }[] = JSON.parse(call.input ?? '[]');
      for (const path of paths)
        if (path.path.startsWith('/doctor-docker-root'))
          path.path = join(root, path.path.slice('/doctor-docker-root'.length));
      return runCommand(
        process.execPath,
        ['-e', call.args[call.args.length - 1]],
        { signal: call.signal, input: JSON.stringify(paths) },
      );
    });
    const result = await probeDockerDisk(f.command, 'docker', info, options());
    assert.ok(
      result.filesystems.some((entry) => entry.roles.includes('docker-root')),
    );
    assert.ok(
      !result.filesystems.some((entry) => entry.roles.includes('image-store')),
    );
    assert.match(result.unknownReasons.join(' '), /symlink.*daemon-host bind/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
