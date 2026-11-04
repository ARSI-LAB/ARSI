import { errorText } from '../../shared/errors.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Runtime } from '../../runtime/context.js';
const help = `ember-rsi — make everything rsi-able

Usage:
  ember-rsi run <recipe.yaml> [--id <experiment-id>] [--resume]
  ember-rsi validate <recipe.yaml>
  ember-rsi list [plugins|policies]
  ember-rsi show <experiment-id>
  ember-rsi cancel <experiment-id>
  ember-rsi reflection list [experiment-id]
  ember-rsi reflection show <revisionID>
  ember-rsi reflection apply <revisionID>
  ember-rsi catalog
  ember-rsi serve [--port 4317]

Run facts are saved in .rsi/ under the current directory. serve listens on localhost only.
Extensions load from ~/.ember-rsi/plugins/<name>/index.mjs by default.
All commands accept repeatable --plugin-dir <directory> options.
Each directory must contain index.mjs exporting register(registry).
`;
function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} needs a value`);
  return value;
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: Runtime | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await mkdir(join(homedir(), '.ember-rsi', 'plugins'), { recursive: true });
    if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
      process.stdout.write(help);
      return 0;
    }
    const command = argv[0]!;
    const args: string[] = [];
    const pluginDirectories: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] === '--plugin-dir') {
        const value = argv[++index];
        if (!value || value.startsWith('--'))
          throw new Error('--plugin-dir needs a value');
        pluginDirectories.push(value);
      } else args.push(argv[index]!);
    }
    if (
      ![
        'run',
        'validate',
        'list',
        'show',
        'cancel',
        'reflection',
        'catalog',
        'serve',
      ].includes(command)
    )
      throw new Error(`Unknown command ${command}`);
    const allowed =
      command === 'run'
        ? ['--id', '--resume']
        : command === 'serve'
          ? ['--port']
          : [];
    for (const item of args)
      if (item.startsWith('--') && !allowed.includes(item))
        throw new Error(`Unknown option ${item}`);
    const { createRuntime, validateRecipe } = await import(
      '../../runtime/context.js'
    );
    runtime = await createRuntime({ pluginDirectories });
    let result: unknown;
    switch (command) {
      case 'run': {
        if (!args[0] || args[0].startsWith('--'))
          throw new Error('Recipe path is required');
        if (args.includes('--resume') && !argument(args, '--id'))
          throw new Error('--resume requires --id');
        result = await runtime.manager.run(resolve(args[0]), {
          id: argument(args, '--id'),
          resume: args.includes('--resume'),
          signal: controller.signal,
        });
        break;
      }
      case 'validate':
        if (!args[0]) throw new Error('Recipe path is required');
        result = await validateRecipe(runtime, args[0]);
        break;
      case 'list': {
        if (
          args.length > 1 ||
          (args[0] &&
            !['plugin', 'plugins', 'policy', 'policies'].includes(args[0]))
        )
          throw new Error('Expected list [plugins|policies]');
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
        if (!args[0]) throw new Error('Experiment ID is required');
        result = await runtime.manager.get(args[0]);
        break;
      case 'cancel':
        if (!args[0]) throw new Error('Experiment ID is required');
        await runtime.manager.cancel(args[0]);
        result = { id: args[0], cancellationRequested: true };
        break;
      case 'reflection': {
        const [action, id, ...extra] = args;
        if (extra.length || !['list', 'show', 'apply'].includes(action ?? ''))
          throw new Error(
            'Expected reflection list [experimentId], show <revisionID>, or apply <revisionID>',
          );
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
        const port = Number(argument(args, '--port') ?? 4317);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new Error('port must be 1..65535');
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
    process.stderr.write(errorText(error) + '\n');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await runtime?.dispose();
  }
}
