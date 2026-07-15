import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TYPESCRIPT_EXTENSIONS = ['.ts', '.mts', '.cts'];

function isTypeScriptUrl(url) {
  if (!url.startsWith('file:')) return false;
  const pathname = new URL(url).pathname;
  return TYPESCRIPT_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

export async function load(url, context, nextLoad) {
  if (!isTypeScriptUrl(url)) return nextLoad(url, context);

  const source = await readFile(new URL(url), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }));
  }

  return {
    format: 'module',
    source: result.outputText,
    shortCircuit: true,
  };
}
