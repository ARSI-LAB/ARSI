import { agentContract } from '../../src/contracts/index.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentLineHandler,
  AgentProcessSpec,
  RuntimeContext,
  Operation,
  JsonObject,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';

export const agentTaskMessage =
  '  Return the requested answer.\r\nUse the evidence.  ';

export const answerSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
export async function agentFixture(
  onLaunch?: (
    spec: AgentProcessSpec,
    onLine: AgentLineHandler,
    context: RuntimeContext,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-execution-'));
  const registry = new Registry();
  const manager = new Manager({
    registry,
    rootDirectory: root,
    directory: join(root, 'data'),
  });
  const owner = manager.context.extend({
    callId: 'owner',
    directory: join(root, 'owner'),
    signal: new AbortController().signal,
  });
  const directory = await prepareAgentProject(
    owner,
    'Read context and edit candidate only when authorized.',
    { 'candidate/input.txt': 'original' },
    [],
    [],
  );
  const charges: { metric: string; amount: number }[] = [];
  const context = owner.extend({
    callId: 'agent',
    directory: join(root, 'agent-call'),
    async charge(metric: string, amount: number) {
      charges.push({ metric, amount });
    },
    async runAgentProcess(
      this: RuntimeContext,
      spec: AgentProcessSpec,
      onLine: AgentLineHandler,
    ) {
      if (this.scope?.limits.modelCalls !== undefined)
        throw new Error('Native CLI cannot enforce modelCalls');
      if (onLaunch) await onLaunch(spec, onLine, this);
      else throw new Error('Unexpected CLI launch');
    },
  });
  await mkdir(context.directory, { recursive: true });
  const request: AgentInput = {
    cwd: directory,
    message: agentTaskMessage,
    outputSchema: answerSchema,
  };
  let serial = 0;
  return {
    async execute(
      operation: Operation,
      input = request,
      scope: RuntimeContext = context,
      config: JsonObject = {},
    ) {
      const id = `agent.fixture-${serial++}`;
      registry.registerOperation({
        id,
        contract: agentContract,
        configSchema: { type: 'object' },
        async create() {
          return operation;
        },
      });
      const managed = await registry.createManagedOperation(id, config, scope);
      try {
        return await managed.execute(input, scope);
      } finally {
        await managed.dispose();
      }
    },
    root,
    manager,
    owner,
    context,
    directory,
    request,
    charges,
    async close() {
      await manager.dispose();
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
