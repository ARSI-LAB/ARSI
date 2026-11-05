import { errorText } from '../../shared/errors.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Runtime } from '../../runtime/context.js';
import { CommandUsageError, parseCommand } from './commands.js';
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: Runtime | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await mkdir(join(homedir(), '.ember-rsi', 'plugins'), { recursive: true });
    const parsed = parseCommand(argv);
    if (parsed.command === 'help') {
      process.stdout.write(parsed.help ?? '');
      return 0;
    }
    const { command, args, pluginDirectories } = parsed;
    const { createRuntime, validateRecipe } = await import(
      '../../runtime/context.js'
    );
    runtime = await createRuntime({ pluginDirectories });
    let result: unknown;
    switch (command) {
      case 'run': {
        result = await runtime.manager.run(resolve(args[0]), {
          id: parsed.id,
          resume: parsed.resume,
          signal: controller.signal,
        });
        break;
      }
      case 'validate':
        result = await validateRecipe(runtime, args[0]);
        break;
      case 'list': {
        if (!args.length) result = await runtime.manager.list();
        else {
          const { describeCatalog } = await import('./catalog.js');
          const catalog = await describeCatalog(runtime.registry);
          result =
            args[0] === 'plugin' || args[0] === 'plugins'
              ? catalog.plugins
              : catalog.policies;
        }
        break;
      }
      case 'show':
        result = await runtime.manager.get(args[0]);
        break;
      case 'cancel':
        await runtime.manager.cancel(args[0]);
        result = { id: args[0], cancellationRequested: true };
        break;
      case 'reflection': {
        const [action, id] = args;
        const revisions = runtime.manager.reflection();
        if (action === 'list') result = await revisions.list(id);
        else {
          if (!id) throw new Error('Revision ID is required');
          result =
            action === 'show'
              ? await revisions.show(id)
              : await revisions.apply(id);
        }
        break;
      }
      case 'catalog':
        result = runtime.registry.catalog();
        break;
      case 'serve': {
        const port = parsed.port ?? 4317;
        const { createServer } = await import('../web/server.js');
        const server = await createServer(runtime);
        const address = await server.listen({ host: '127.0.0.1', port });
        process.stdout.write(`ember-rsi ${address}\n`);
        try {
          await new Promise<void>((done) => {
            if (controller.signal.aborted) done();
            else
              controller.signal.addEventListener('abort', () => done(), {
                once: true,
              });
          });
        } finally {
          await server.close();
        }
        return 0;
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    if (error instanceof CommandUsageError) {
      process.stderr.write(error.helpText);
      return 2;
    }
    process.stderr.write(errorText(error) + '\n');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await runtime?.dispose();
  }
}
