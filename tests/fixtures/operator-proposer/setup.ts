import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepareOperatorFixture } from '../operator-sdk/setup.js';

export const operatorFixtureSource = (marker: string): string =>
  `# ${marker}\ndef kernel_function(x):\n    for i in range(2):\n        y = x + 1\n    return y\n`;

export async function prepareOperatorProposerFixture(): Promise<
  Awaited<ReturnType<typeof prepareOperatorFixture>> & {
    modelDirectory: string;
    identityFile: string;
    embeddingPython: string;
    resourcesDirectory: string;
    retrievalScript: string;
    entrySource: string;
  }
> {
  const fixture = await prepareOperatorFixture();
  const entrySource = operatorFixtureSource('fixture:latency=10');
  await writeFile(join(fixture.root, 'example/baseline/input.py'), entrySource);
  const modelDirectory = join(fixture.root, 'model');
  await mkdir(modelDirectory);
  const bytes = Buffer.from('{"fixture":true}\n');
  await writeFile(join(modelDirectory, 'config.json'), bytes);
  const identityFile = join(fixture.root, 'embedding-identity.json');
  await writeFile(
    identityFile,
    JSON.stringify({
      schemaVersion: 'rsi.operator-embedding-identity/v1',
      model: { id: 'test-model', revision: 'test-revision' },
      encoding: {
        queryPromptName: 'query',
        normalizeEmbeddings: true,
        device: 'cpu',
        batchSize: 32,
      },
      files: [
        {
          path: 'config.json',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  const embeddingPython = join(fixture.root, 'embedding-worker.mjs');
  await writeFile(
    embeddingPython,
    `#!${process.execPath}\nimport {readFile,writeFile} from 'node:fs/promises';\nconst arg=name=>process.argv[process.argv.indexOf(name)+1];\nconst request=JSON.parse(await readFile(arg('--request'),'utf8'));const identity=JSON.parse(await readFile(request.identityFile,'utf8'));\nawait writeFile(arg('--response'),JSON.stringify({schemaVersion:'rsi.operator-retrieval/v1',embeddingDigest:request.embeddingDigest,resourcesDigest:request.resourcesDigest,matches:[],knowledgeContext:'',omitted:{techniques:[],examples:[]},model:identity.model,runtime:{python:'TEST-FIXTURE',sentenceTransformers:'TEST-FIXTURE',transformers:'TEST-FIXTURE',torch:'TEST-FIXTURE'}}));\n`,
  );
  await chmod(embeddingPython, 0o755);
  const resourcesDirectory = join(fixture.root, 'resources');
  await prepareKnowledgeFixture(resourcesDirectory);
  // Fixture interpreter identity follows the Node executable running this test.
  const worker = await readFile(fixture.worker, 'utf8');
  await writeFile(
    fixture.worker,
    worker.replace(/^#!.*\n/, `#!${process.execPath}\n`),
  );
  return {
    ...fixture,
    modelDirectory,
    identityFile,
    embeddingPython,
    resourcesDirectory,
    retrievalScript: embeddingPython,
    entrySource,
  };
}

/** Small external bundle used to exercise loading, never production knowledge. */
export async function prepareKnowledgeFixture(
  directory: string,
): Promise<void> {
  await mkdir(join(directory, 'knowledge'), { recursive: true });
  const document = JSON.stringify({
    id: 'core_partition',
    content: 'Fixture technique',
  });
  const example = '# fixture example\n';
  await writeFile(join(directory, 'knowledge/technique.json'), document);
  await writeFile(join(directory, 'knowledge/example.txt'), example);
  await writeFile(
    join(directory, 'knowledge/manifest.json'),
    JSON.stringify({
      schemaVersion: 'rsi.operator-knowledge/v1',
      techniques: [
        {
          id: 'core_partition',
          document: 'knowledge/technique.json',
          example: 'knowledge/example.txt',
        },
      ],
      metrics: [],
      resources: [
        {
          path: 'knowledge/technique.json',
          sha256: createHash('sha256').update(document).digest('hex'),
        },
        {
          path: 'knowledge/example.txt',
          sha256: createHash('sha256').update(example).digest('hex'),
        },
      ],
    }),
  );
}
