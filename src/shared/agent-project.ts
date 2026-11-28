import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ArtifactStore } from '../contracts/index.js';

export const projectMarker = '.rsi-project';

export async function assertOwnedAgentProject(
  directory: string,
  project: string,
): Promise<void> {
  const hash = basename(dirname(project));
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    project !== join(resolve(directory), 'agent-projects', hash, 'project') ||
    (await realpath(project)) !==
      join(await realpath(directory), 'agent-projects', hash, 'project') ||
    !(await lstat(join(project, projectMarker))).isFile()
  )
    throw new Error('Agent cwd does not resolve to its authorized project');
}

export async function publishAgentProject(
  staging: string,
  directory: string,
  artifacts: ArtifactStore,
  verifyExisting?: (project: string) => Promise<void>,
): Promise<string> {
  const artifact = await artifacts.capture(staging);
  const hash = artifact.slice('artifact:'.length);
  const project = join(directory, 'agent-projects', hash, 'project');
  let parent = directory;
  for (const segment of ['agent-projects', hash]) {
    parent = join(parent, segment);
    try {
      await mkdir(parent);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
    }
    if (!(await lstat(parent)).isDirectory())
      throw new Error('Agent project parent must be a regular directory');
  }
  const owner = await realpath(directory);
  if (
    (await realpath(dirname(project))) !== join(owner, 'agent-projects', hash)
  )
    throw new Error('Agent project parent is outside its owning call');
  const published = async (): Promise<boolean> => {
    let existing;
    try {
      existing = await lstat(project);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    }
    if (!existing.isDirectory())
      throw new Error('Agent project must be a regular directory');
    const marker = await lstat(join(project, projectMarker));
    if (!marker.isFile() || marker.size !== 0)
      throw new Error('Agent project marker must be a regular empty file');
    await verifyExisting?.(project);
    return true;
  };
  if (await published()) return project;
  // Keep the input snapshot immutable and use a stable, separate path for execution.
  try {
    await rename(staging, project);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
    )
      throw error;
    // Windows reports a concurrent directory publication as EPERM. Only a
    // verified, already-published project fulfills this call; other errors stay errors.
    if (!(await published())) throw error;
  }
  return project;
}
