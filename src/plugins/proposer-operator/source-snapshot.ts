import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Candidate,
  type JsonObject,
  type RuntimeContext,
} from '../../contracts/index.js';
import { type OperatorProposerConfig } from './schema.js';
import { readOperatorSource } from '../shared/operator-attempt/service.js';
import {
  sourceSnapshot,
  type OperatorStageInput,
} from '../shared/operator-attempt/agent.js';

export async function operatorSnapshot(
  parent: Candidate,
  config: OperatorProposerConfig,
  assessment: JsonObject,
  context: RuntimeContext,
): Promise<
  Pick<
    OperatorStageInput,
    'sourcePath' | 'sourceFiles' | 'editablePaths' | 'files'
  >
> {
  const source = await readOperatorSource(parent, assessment, context);
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(source.files))
    files[sourceSnapshot + path] = content;
  for (const name of ['problem.py', 'test.py', 'task.json'])
    files['context/task/' + name] = await readFile(
      join(config.task.directory, name),
      'utf8',
    );
  return {
    sourcePath: source.sourcePath,
    sourceFiles: Object.keys(source.files),
    editablePaths: source.editablePaths,
    files,
  };
}
