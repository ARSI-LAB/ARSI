import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { JsonObject, RuntimeContext } from '../../../contracts/index.js';
import { excludedArtifactEntries } from '../../../runtime/storage/index.js';
import { object } from '../../../shared/json.js';
import { safePath } from '../file-application/target.js';

export type AgentRole = {
  name: string;
  description: string;
  prompt: string;
};

export const projectMarker = '.rsi-project';
export const roleNamePattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const validName = new RegExp(roleNamePattern);

function toml(value: string): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}

export async function prepareAgentProject(
  context: RuntimeContext,
  prompt: string,
  files: JsonObject,
  skills: readonly string[],
  roles: readonly AgentRole[],
): Promise<string> {
  await mkdir(context.directory, { recursive: true });
  const staging = await mkdtemp(join(context.directory, 'agent-input-'));
  const write = async (path: string, content: string): Promise<void> => {
    const relativePath = safePath(path);
    if (
      relativePath
        .split('/')
        .some((part) => excludedArtifactEntries.includes(part))
    )
      throw new Error(`Agent project file cannot be captured: ${path}`);
    const destination = join(staging, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
  };
  try {
    const skillNames = new Set<string>();
    for (const directory of skills) {
      const root = await lstat(directory);
      if (!root.isDirectory())
        throw new Error(`Expected a skill directory: ${directory}`);
      const entry = join(directory, 'SKILL.md');
      if (!(await lstat(entry)).isFile())
        throw new Error(`Expected a regular SKILL.md: ${entry}`);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        await readFile(entry, 'utf8'),
      );
      if (!frontmatter) throw new Error(`Missing skill frontmatter: ${entry}`);
      const metadata = object(parse(frontmatter[1]!));
      const { name, description } = metadata;
      if (
        typeof name !== 'string' ||
        !validName.test(name) ||
        typeof description !== 'string' ||
        !description.trim()
      )
        throw new Error(`Invalid skill name or description: ${entry}`);
      if (skillNames.has(name))
        throw new Error(`Duplicate skill name: ${name}`);
      skillNames.add(name);
      await context.artifacts.materialize(
        await context.artifacts.capture(directory),
        join(staging, '.agents', 'skills', name),
      );
    }
    const roleNames = new Set<string>();
    for (const role of roles) {
      if (!validName.test(role.name) || roleNames.has(role.name))
        throw new Error(`Invalid or duplicate agent role: ${role.name}`);
      roleNames.add(role.name);
      const body = await readFile(role.prompt, 'utf8');
      if (!role.description.trim() || !body.trim())
        throw new Error(
          `Agent role ${role.name} requires a description and instructions`,
        );
      await write(`roles/${role.name}.md`, body);
      await write(
        `.codex/agents/${role.name}.toml`,
        `name = ${toml(role.name)}\ndescription = ${toml(role.description)}\ndeveloper_instructions = ${toml(body)}\n`,
      );
    }
    const catalog = roles.length
      ? '\n\n## Delegation\n\nDelegate self-contained tasks with subagent in Pi or spawn_agent in Codex. Subagents share this project and return findings. Only the main agent proposes final edits.\n\n' +
        roles
          .map(({ name, description }) => `- ${name}: ${description}`)
          .join('\n')
      : '';
    const instructions = `${prompt.trimEnd()}${catalog}\n`;
    if (Buffer.byteLength(instructions) > 24 * 1024) {
      await write('context/instructions.md', prompt);
      await write(
        'AGENTS.md',
        `Read context/instructions.md before beginning the task.${catalog}\n`,
      );
    } else {
      await write('AGENTS.md', instructions);
    }
    await write(projectMarker, '');
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== 'string')
        throw new Error(`Expected text for project file ${path}`);
      await write(path, content);
    }
    const artifact = await context.artifacts.capture(staging);
    const hash = artifact.slice('artifact:'.length);
    const project = join(context.directory, 'agent-projects', hash, 'project');
    let parent = context.directory;
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
    const owner = await realpath(context.directory);
    if (
      (await realpath(dirname(project))) !== join(owner, 'agent-projects', hash)
    )
      throw new Error('Agent project parent is outside its owning call');
    const published = async (): Promise<boolean> => {
      let existing;
      try {
        existing = await lstat(project);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return false;
        throw error;
      }
      if (!existing.isDirectory())
        throw new Error('Agent project must be a regular directory');
      const marker = await lstat(join(project, projectMarker));
      if (!marker.isFile() || marker.size !== 0)
        throw new Error('Agent project marker must be a regular empty file');
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
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
