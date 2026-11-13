import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readObservation } from '../../web/api/observation-client.js';

test('Web imports only contract types, observation types, and approved pure utilities', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const web = resolve(root, 'web');
  const sourceRoot = resolve(root, 'src') + sep;
  const contracts = resolve(root, 'src/contracts') + sep;
  const observationClient = resolve(web, 'api/observation-client.ts');
  const policyModel = resolve(root, 'src/shared/observation/policy-structure');
  const policyParser = resolve(root, 'src/shared/policy-expression-syntax');
  const rangePreview = resolve(
    root,
    'src/shared/observation/policy-range-preview',
  );
  const pureUtilities = new Set([
    resolve(root, 'src/shared/iterations.js'),
    `${policyParser}.js`,
    `${rangePreview}.js`,
  ]);
  const policySources = [policyModel, policyParser, rangePreview].map(
    (path) => `${path}.ts`,
  );
  const verify = (
    filename: string,
    specifier: string,
    typeOnly: boolean,
  ): void => {
    if (policySources.includes(filename)) {
      assert.ok(
        typeOnly,
        `${filename} must have no runtime imports: ${specifier}`,
      );
      return;
    }
    if (!specifier.startsWith('.')) return;
    const target = resolve(dirname(filename), specifier);
    if (target.startsWith(sourceRoot)) {
      assert.ok(
        (target.startsWith(contracts) && typeOnly) ||
          (filename === observationClient &&
            target === `${policyModel}.js` &&
            typeOnly) ||
          pureUtilities.has(target),
        `${filename} must use contract types, observation types, or approved pure utilities: ${specifier}`,
      );
    }
  };
  const consumer = resolve(web, 'consumer.ts');
  verify(consumer, '../src/shared/iterations.js', false);
  verify(consumer, '../src/shared/policy-expression-syntax.js', false);
  verify(consumer, '../src/shared/observation/policy-range-preview.js', false);
  const policyModelImport = '../../src/shared/observation/policy-structure.js';
  verify(observationClient, policyModelImport, true);
  assert.throws(() => verify(observationClient, policyModelImport, false));
  assert.throws(() =>
    verify(consumer, '../src/shared/observation/policy-structure.js', true),
  );
  for (const specifier of [
    '../src/runtime/manager/index.js',
    '../src/runtime/policy/expression.js',
    '../src/plugins/agent-pi/index.js',
    '../src/contracts/index.js',
    '../src/contracts/runtime/context.js',
    '../src/contracts/runtime/execution.js',
    '../src/shared/json.js',
  ]) {
    assert.throws(() => verify(consumer, specifier, false));
  }
  const webSources = (await readdir(web, { recursive: true }))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => resolve(web, name));
  for (const filename of [...webSources, ...policySources]) {
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
    { url: 'api/observation/experiments/example', method: 'GET' },
  ]);
});
