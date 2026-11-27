import { readFile } from 'node:fs/promises';
import type { JsonObject, RuntimeContext } from '../../../contracts/index.js';

export type MessageTemplates<Stage extends string = never> = Partial<
  Record<'default' | Stage, string>
>;
export type MessageVariables = Readonly<Record<string, string | number>>;
export type MessageStage = { name: string; variables: MessageVariables };

export function messageTemplatesSchema(...stages: string[]): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      ['default', ...stages].map((stage) => [
        stage,
        { type: 'string', minLength: 1, 'x-rsi-path': 'local-file' },
      ]),
    ),
  };
}

export async function renderTaskMessage(
  context: Pick<RuntimeContext, 'bindingId' | 'signal'>,
  templates: MessageTemplates<string> | undefined,
  fallback: string,
  variables: MessageVariables,
  stage?: MessageStage,
): Promise<string> {
  const override =
    stage && templates?.[stage.name] !== undefined ? stage : undefined;
  const key = override?.name ?? 'default';
  const file = templates?.[key];
  if (file === undefined) return fallback;
  const location = `${context.bindingId}.config.messageTemplates.${key} (${file})`;
  const source = await readFile(file, {
    encoding: 'utf8',
    signal: context.signal,
  }).catch((cause: unknown) => {
    context.signal.throwIfAborted();
    throw new Error(`${location}: could not read template`, { cause });
  });
  const values = { ...variables, ...override?.variables };
  const body = source.replace(/\{\{[\s\S]*?\}\}|\{\{/g, (placeholder) => {
    const name = /^\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}$/.exec(
      placeholder,
    )?.[1];
    if (name === undefined)
      throw new Error(
        `${location}: malformed placeholder ${JSON.stringify(placeholder)}`,
      );
    if (!Object.hasOwn(values, name))
      throw new Error(`${location}: unknown variable ${JSON.stringify(name)}`);
    return String(values[name]);
  });
  if (!body.trim())
    throw new Error(`${location}: task message must not be empty`);
  return body;
}
