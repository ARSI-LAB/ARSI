import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Reduce these edges as their callers migrate to public contracts.
const legacy = [
  [
    'src/plugins/proposer-agent/execution-context.ts',
    'src/runtime/services/facts/evidence-packets.ts',
  ],
  ['src/plugins/shared/agent-editing/index.ts', 'src/runtime/storage/index.ts'],
  [
    'src/plugins/shared/agent-editing/project.ts',
    'src/runtime/storage/index.ts',
  ],
];

function boundaryViolation(source, target) {
  if (target.startsWith('examples/'))
    return 'Source and web modules cannot depend on examples. Move reusable code into its owning source module.';
  if (
    source.startsWith('src/contracts/') &&
    /^(src\/(runtime|plugins|entries)|web)\//.test(target)
  )
    return 'Contracts cannot import implementations. Define the shared type in contracts and inject its implementation.';
  if (
    source.startsWith('web/') &&
    /^src\/(runtime|plugins|entries)\//.test(target)
  )
    return 'The web client must use public contracts and the management API.';
  const plugin = /^src\/plugins\/([^/]+)\//;
  const owner = source.match(plugin)?.[1];
  const dependency = target.match(plugin)?.[1];
  if (dependency && dependency !== 'shared') {
    if (
      source.startsWith('src/runtime/') &&
      source !== 'src/runtime/builtins.ts'
    )
      return 'Only runtime/builtins.ts assembles concrete plugins. Use the registry or a contract.';
    if (owner && owner !== dependency)
      return 'Plugins cannot import another concrete plugin. Move shared behavior into plugins/shared or call a contract.';
  }
  if (owner && target.startsWith('src/runtime/'))
    return 'Plugins must use RuntimeContext or public contracts for runtime services.';
}

function moduleLiteral(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  )
    return node.arguments[0];
}

export function checkArchitecture(root) {
  const errors = [];
  const observedLegacy = new Set();
  const portable = (file) => relative(root, file).split(sep).join('/');
  const plugins = join(root, 'src/plugins');
  if (existsSync(plugins)) {
    for (const dir of readdirSync(plugins, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === 'shared') continue;
      for (const required of ['index.ts', 'schema.ts', 'service.ts']) {
        const file = join(plugins, dir.name, required);
        if (!ts.sys.fileExists(file))
          errors.push(
            `${portable(file)}:1: Public plugin layout requires ${required}. Provide the plugin entry point, schema and service in their owning files.`,
          );
      }
    }
  }
  for (const [layer, configName] of [
    ['src', 'tsconfig.json'],
    ['web', 'tsconfig.web.json'],
  ]) {
    const config = ts.readConfigFile(join(root, configName), ts.sys.readFile);
    if (config.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
      );
    const { options } = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      root,
    );
    const cache = ts.createModuleResolutionCache(root, (s) => s, options);
    for (const path of ts.sys.readDirectory(join(root, layer), [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
    ])) {
      const source = portable(path);
      const ast = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        false,
      );
      function visit(node) {
        const literal = moduleLiteral(node);
        if (literal && ts.isStringLiteralLike(literal)) {
          const specifier = literal.text;
          const result = ts.resolveModuleName(
            specifier,
            path,
            options,
            ts.sys,
            cache,
          ).resolvedModule;
          const targetPath =
            result?.resolvedFileName ??
            (specifier.startsWith('.')
              ? resolve(dirname(path), specifier)
              : undefined);
          if (targetPath) {
            const target = portable(targetPath);
            const edge = legacy.find(
              ([caller, dependency]) =>
                source === caller && target === dependency,
            );
            if (edge) observedLegacy.add(edge);
            else {
              const message = boundaryViolation(source, target);
              if (message)
                errors.push(
                  `${source}:${ast.getLineAndCharacterOfPosition(literal.getStart(ast)).line + 1}: ${target}: ${message}`,
                );
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  for (const edge of legacy) {
    if (!observedLegacy.has(edge))
      errors.push(
        `${edge[0]}:1: The dependency on ${edge[1]} has been removed. Delete this stale edge from the allowlist in scripts/check-architecture.mjs.`,
      );
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const errors = checkArchitecture(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}
