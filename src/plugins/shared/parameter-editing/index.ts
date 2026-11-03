import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject, RuntimeContext } from '../../../contracts/index.js';
import { applicationContract } from '../../../contracts/plugin-types/application.js';
import { canonical, object, string } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';

/** Commit tuned keys against a fixed parent; Application owns validation and sealing. */
export async function commitParameters(
  parentRef: string,
  path: string,
  parameters: JsonObject,
  context: RuntimeContext,
): Promise<string> {
  const parent = await context.readCandidate(parentRef);
  const edit = await context.workspaces.create(parent.artifactRef, parent.ref);
  try {
    const file = join(edit.directory, path);
    const original = object(JSON.parse(await readFile(file, 'utf8')), path);
    if (
      Object.entries(parameters).some(
        ([name, value]) =>
          !Object.hasOwn(original, name) ||
          canonical(original[name]) !== canonical(value),
      )
    ) {
      await writeFile(
        file,
        JSON.stringify({ ...original, ...parameters }, null, 2) + '\n',
      );
    }
    context.signal.throwIfAborted();
    const committed = await context.application({
      action: 'commit',
      parentCandidateRef: parent.ref,
      editRef: edit.ref,
    });
    validate(
      applicationContract.output_schema,
      committed,
      'Application commit output',
    );
    if (committed.action !== 'commit')
      throw new Error('Application did not return a commit result');
    return string(committed.candidateRef);
  } finally {
    await context.workspaces.release(edit.ref);
  }
}
