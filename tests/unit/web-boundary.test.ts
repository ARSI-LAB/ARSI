import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readObservation } from '../../web/api/observation-client.js';

test('Web uses the public contracts as types and never imports Runtime or plugin implementations', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const web = resolve(root, 'web');
  const sourceRoot = resolve(root, 'src') + sep;
  const contracts = resolve(root, 'src/contracts') + sep;
  const verify = (
    filename: string,
    specifier: string,
    typeOnly: boolean,
  ): void => {
    if (!specifier.startsWith('.')) return;
    const target = resolve(dirname(filename), specifier);
    if (target.startsWith(sourceRoot)) {
      assert.ok(
        target.startsWith(contracts) && typeOnly,
        `${filename} must use public contracts as types only: ${specifier}`,
      );
    }
  };
  for (const name of await readdir(web, { recursive: true })) {
    if (!/\.tsx?$/.test(name)) continue;
    const filename = resolve(web, name);
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause;
        const types =
          !!clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              !!clause.namedBindings &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.every(
                (element) => element.isTypeOnly,
              )));
        verify(filename, node.moduleSpecifier.text, types);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        verify(filename, node.moduleSpecifier.text, node.isTypeOnly);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument))
          verify(filename, argument.text, false);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test('the observation HTTP client explicitly sends GET requests to the query interface', async (t) => {
  const requests: { url: string; method: string | undefined }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ recorded: true }));
    },
  );
  assert.deepEqual(await readObservation('/example', (raw) => raw), {
    recorded: true,
  });
  assert.deepEqual(requests, [
    { url: '/api/observation/experiments/example', method: 'GET' },
  ]);
});
