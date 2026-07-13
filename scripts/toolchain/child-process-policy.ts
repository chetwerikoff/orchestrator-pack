import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import ts from 'typescript';
import { repoRelative, walkFiles } from '#opk-toolchain/fs-utils';

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const RAW_APIS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

export interface RawChildProcessCall {
  readonly path: string;
  readonly api: string;
  readonly fingerprint: string;
  readonly ordinal: number;
  readonly source: string;
}

export interface RawChildProcessBaselineEntry
  extends Pick<RawChildProcessCall, 'path' | 'api' | 'fingerprint' | 'ordinal'> {
  readonly justification: string;
}

export interface RawChildProcessBaseline {
  readonly version: 1;
  readonly entries: readonly RawChildProcessBaselineEntry[];
}

interface ImportBindings {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
}

function moduleText(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importBindings(sourceFile: ts.SourceFile): ImportBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && CHILD_PROCESS_MODULES.has(moduleText(statement.moduleSpecifier) ?? '')) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (RAW_APIS.has(imported)) named.set(element.name.text, imported);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') continue;
      if (!CHILD_PROCESS_MODULES.has(moduleText(initializer.arguments[0]) ?? '')) continue;
      if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.getText(sourceFile);
          const local = element.name.getText(sourceFile);
          if (RAW_APIS.has(imported)) named.set(local, imported);
        }
      }
    }
  }
  return { named, namespaces };
}

function isChildProcessRequire(node: ts.Expression): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && CHILD_PROCESS_MODULES.has(moduleText(node.arguments[0]) ?? '');
}

function rawApi(call: ts.CallExpression, bindings: ImportBindings): string | undefined {
  if (ts.isIdentifier(call.expression)) return bindings.named.get(call.expression.text);
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  if (ts.isIdentifier(receiver) && !bindings.namespaces.has(receiver.text)) return undefined;
  if (!ts.isIdentifier(receiver) && !isChildProcessRequire(receiver)) return undefined;
  return RAW_APIS.has(call.expression.name.text) ? call.expression.name.text : undefined;
}

function normalizedSource(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  return call.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function fingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 20);
}

export function discoverRawChildProcessCalls(
  repoRoot: string,
  exempt: (path: string) => boolean = (path) => path === 'scripts/kernel/subprocess.ts'
    || /^scripts\/kernel\/.*\.test\.ts$/.test(path),
): RawChildProcessCall[] {
  const discovered: Omit<RawChildProcessCall, 'ordinal'>[] = [];
  for (const absolutePath of walkFiles(repoRoot, (path) => SOURCE_EXTENSIONS.has(extname(path)))) {
    const path = repoRelative(repoRoot, absolutePath);
    if (exempt(path)) continue;
    const source = readFileSync(absolutePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS,
    );
    const bindings = importBindings(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const api = rawApi(node, bindings);
        if (api) {
          const callSource = normalizedSource(node, sourceFile);
          discovered.push({ path, api, fingerprint: fingerprint(callSource), source: callSource });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const counts = new Map<string, number>();
  return discovered
    .sort((left, right) => left.path.localeCompare(right.path) || left.api.localeCompare(right.api) || left.source.localeCompare(right.source))
    .map((entry) => {
      const key = `${entry.path}\0${entry.api}\0${entry.fingerprint}`;
      const ordinal = (counts.get(key) ?? 0) + 1;
      counts.set(key, ordinal);
      return { ...entry, ordinal };
    });
}

export function rawCallKey(call: Pick<RawChildProcessCall, 'path' | 'api' | 'fingerprint' | 'ordinal'>): string {
  return `${call.path}|${call.api}|${call.fingerprint}|${call.ordinal}`;
}

export interface PolicyComparison {
  readonly added: readonly RawChildProcessCall[];
  readonly stale: readonly RawChildProcessBaselineEntry[];
}

export function compareRawChildProcessBaseline(
  actual: readonly RawChildProcessCall[],
  baseline: RawChildProcessBaseline,
): PolicyComparison {
  if (baseline.version !== 1) throw new Error(`unsupported raw child-process baseline version: ${String(baseline.version)}`);
  const actualByKey = new Map(actual.map((entry) => [rawCallKey(entry), entry]));
  const baselineByKey = new Map(baseline.entries.map((entry) => [rawCallKey(entry), entry]));
  return {
    added: actual.filter((entry) => !baselineByKey.has(rawCallKey(entry))),
    stale: baseline.entries.filter((entry) => !actualByKey.has(rawCallKey(entry))),
  };
}

export function makeRawChildProcessBaseline(
  calls: readonly RawChildProcessCall[],
): RawChildProcessBaseline {
  return {
    version: 1,
    entries: calls.map((call) => ({
      path: call.path,
      api: call.api,
      fingerprint: call.fingerprint,
      ordinal: call.ordinal,
      justification: 'Pre-existing direct child-process call grandfathered by Issue #800; migrate it to the sanctioned kernel when its consumer is ported.',
    })),
  };
}
