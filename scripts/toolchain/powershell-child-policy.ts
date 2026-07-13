import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import ts from 'typescript';
import { repoRelative, walkFiles } from '#opk-toolchain/fs-utils';

const TEST_SUFFIXES = ['.test.ts', '.test.mts', '.test.cts', '.test.js', '.test.mjs', '.test.cjs'];
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const CHILD_APIS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);
const PWSH_EXECUTABLE = /^(?:pwsh|powershell)(?:\.exe)?$/i;

export interface PowerShellBootTest {
  readonly path: string;
  readonly mechanisms: readonly string[];
}

export interface PowerShellBootBaselineEntry {
  readonly path: string;
  readonly justification: string;
}

export interface PowerShellBootBaseline {
  readonly version: 1;
  readonly entries: readonly PowerShellBootBaselineEntry[];
}

interface ChildBindings {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
  readonly importsSharedPwshHelper: boolean;
  readonly stringConstants: ReadonlyMap<string, string>;
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function analyzeImports(sourceFile: ts.SourceFile): ChildBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  let importsSharedPwshHelper = false;
  const stringConstants = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = literalText(statement.moduleSpecifier) ?? '';
      if (module.includes('_test-pwsh-helpers')) importsSharedPwshHelper = true;
      if (!CHILD_PROCESS_MODULES.has(module)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (CHILD_APIS.has(imported)) named.set(element.name.text, imported);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (ts.isIdentifier(declaration.name)) {
        const constantValue = literalText(initializer);
        if (constantValue !== undefined) stringConstants.set(declaration.name.text, constantValue);
      }
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') continue;
      const module = literalText(initializer.arguments[0]) ?? '';
      if (module.includes('_test-pwsh-helpers')) importsSharedPwshHelper = true;
      if (!CHILD_PROCESS_MODULES.has(module)) continue;
      if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.getText(sourceFile);
          const local = element.name.getText(sourceFile);
          if (CHILD_APIS.has(imported)) named.set(local, imported);
        }
      }
    }
  }

  return { named, namespaces, importsSharedPwshHelper, stringConstants };
}

function isChildProcessRequire(node: ts.Expression): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && CHILD_PROCESS_MODULES.has(literalText(node.arguments[0]) ?? '');
}

function childApi(call: ts.CallExpression, bindings: ChildBindings): string | undefined {
  if (ts.isIdentifier(call.expression)) return bindings.named.get(call.expression.text);
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  if (ts.isIdentifier(receiver) && !bindings.namespaces.has(receiver.text)) return undefined;
  if (!ts.isIdentifier(receiver) && !isChildProcessRequire(receiver)) return undefined;
  return CHILD_APIS.has(call.expression.name.text) ? call.expression.name.text : undefined;
}

function commandStartsPowerShell(command: string): boolean {
  const trimmed = command.trim();
  const first = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed);
  const token = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
  return PWSH_EXECUTABLE.test(token.replaceAll('\\', '/').split('/').at(-1) ?? token);
}

function isPowerShellCall(call: ts.CallExpression, bindings: ChildBindings): string | undefined {
  const api = childApi(call, bindings);
  if (!api) return undefined;
  const firstArgument = call.arguments[0];
  const executable = literalText(firstArgument)
    ?? (firstArgument && ts.isIdentifier(firstArgument) ? bindings.stringConstants.get(firstArgument.text) : undefined);
  if (!executable) {
    return firstArgument && ts.isIdentifier(firstArgument) && /pwsh|powershell/i.test(firstArgument.text)
      ? api
      : undefined;
  }
  if (api === 'exec' || api === 'execSync') return commandStartsPowerShell(executable) ? api : undefined;
  const basename = executable.replaceAll('\\', '/').split('/').at(-1) ?? executable;
  return PWSH_EXECUTABLE.test(basename) ? api : undefined;
}

function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

export function discoverPowerShellBootTests(repoRoot: string): PowerShellBootTest[] {
  const result: PowerShellBootTest[] = [];
  for (const absolutePath of walkFiles(repoRoot, (path) => isTestFile(path) && ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(extname(path)))) {
    const path = repoRelative(repoRoot, absolutePath);
    const source = readFileSync(absolutePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const bindings = analyzeImports(sourceFile);
    const mechanisms = new Set<string>();
    if (bindings.importsSharedPwshHelper) mechanisms.add('shared-helper:_test-pwsh-helpers');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const api = isPowerShellCall(node, bindings);
        if (api) mechanisms.add(`direct:${api}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (mechanisms.size > 0) {
      result.push({ path, mechanisms: [...mechanisms].sort() });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export interface PowerShellBaselineComparison {
  readonly added: readonly PowerShellBootTest[];
  readonly stale: readonly PowerShellBootBaselineEntry[];
}

export function comparePowerShellBootBaseline(
  actual: readonly PowerShellBootTest[],
  baseline: PowerShellBootBaseline,
): PowerShellBaselineComparison {
  if (baseline.version !== 1) throw new Error(`unsupported PowerShell child-test baseline version: ${String(baseline.version)}`);
  const actualPaths = new Set(actual.map((entry) => entry.path));
  const baselinePaths = new Set(baseline.entries.map((entry) => entry.path));
  return {
    added: actual.filter((entry) => !baselinePaths.has(entry.path)),
    stale: baseline.entries.filter((entry) => !actualPaths.has(entry.path)),
  };
}

export function makePowerShellBootBaseline(actual: readonly PowerShellBootTest[]): PowerShellBootBaseline {
  return {
    version: 1,
    entries: actual.map((entry) => ({
      path: entry.path,
      justification: `Pre-existing PowerShell child test at the Issue #800 baseline (${entry.mechanisms.join(', ')}); preserve until that test is migrated in a later PR.`,
    })),
  };
}
