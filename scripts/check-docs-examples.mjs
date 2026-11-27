import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Each guide is its own ESM example project. Named blocks support multi-file
// examples; anonymous blocks are separate modules. Resolve the documented public
// imports to this checkout so a stale dist/ cannot mask a broken example.
export function checkExamples(root, docs, report) {
  const scratch = path.join(root, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const temp = mkdtempSync(path.join(scratch, 'doc-typecheck-'));
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    const paths = {};
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      const name = path.posix.join(manifest.name, subpath);
      paths[name] = [
        entry.types.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts'),
      ];
    }
    const options = {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      baseUrl: root,
      paths,
    };
    let count = 0;
    for (const [file, { blocks }] of docs) {
      const sources = new Map();
      const dir = path.join(temp, String(count++));
      for (const { info, code, line } of blocks) {
        const [language, ...metadata] = info.split(/\s+/);
        if (
          !['ts', 'typescript'].includes(language) ||
          metadata.includes('ignore-check')
        )
          continue;
        const named = metadata.find((entry) => entry.startsWith('file='));
        const name = named ? named.slice(5) : 'block-' + line + '.ts';
        if (!/^(?:[\w-]+\/)*[\w.-]+\.ts$/.test(name)) {
          report(
            file,
            line,
            'Use a relative TypeScript example filename for file=.',
          );
          continue;
        }
        const source = path.join(dir, name);
        if (sources.has(source)) {
          report(
            file,
            line,
            'Give each example file in this guide a unique file= name.',
          );
          continue;
        }
        sources.set(source, line);
        mkdirSync(path.dirname(source), { recursive: true });
        writeFileSync(source, code + '\nexport {};\n');
      }
      if (!sources.size) continue;
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
      const program = ts.createProgram([...sources.keys()], options);
      for (const [source, line] of sources) {
        const sf = program.getSourceFile(source);
        const diagnostics = [
          ...program.getSyntacticDiagnostics(sf),
          ...program.getSemanticDiagnostics(sf),
        ];
        for (const diag of diagnostics) {
          const offset = sf.getLineAndCharacterOfPosition(diag.start ?? 0).line;
          const message = ts.flattenDiagnosticMessageText(
            diag.messageText,
            ' ',
          );
          report(
            file,
            line + offset + 1,
            'TS' +
              diag.code +
              ': ' +
              message +
              ' Update the example to match the public API.',
          );
        }
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
