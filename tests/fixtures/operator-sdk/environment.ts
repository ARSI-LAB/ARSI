import { after, before } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Keep SDK tests independent of the developer's network configuration. */
export function useOperatorSdkTestEnvironment(): void {
  let directory: string | undefined;
  let previous: string | undefined;
  before(async () => {
    previous = process.env.EVALUATOR_NETWORK_CONFIG;
    directory = await mkdtemp(join(tmpdir(), 'rsi-operator-sdk-environment-'));
    const network = join(directory, 'network.yaml');
    await writeFile(network, '{}\n');
    process.env.EVALUATOR_NETWORK_CONFIG = network;
  });
  after(async () => {
    if (previous === undefined) delete process.env.EVALUATOR_NETWORK_CONFIG;
    else process.env.EVALUATOR_NETWORK_CONFIG = previous;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
}
