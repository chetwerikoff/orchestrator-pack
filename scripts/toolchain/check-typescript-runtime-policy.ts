import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import {
  assertNodeRuntimeContract,
  NODE_ENGINE_DECLARATION,
  NODE_VERSION_FILE,
  SUPPORTED_NODE_MAJOR,
} from './node-runtime-contract.mjs';

export type LaunchClassification =
  | 'native-node-22'
  | 'powershell-bridge'
  | 'test-framework-owned'
  | 'historical-fixture-only'
  | 'invalid';

export interface LaunchInventoryEntry {
  readonly path: string;
  readonly line: number;
  readonly classification: LaunchClassification;
  readonly evidence: string;
}

export interface RuntimePolicyViolation {
  readonly path: string;
  readonly line: number;
  readonly rule:
    | 'node-contract'
    | 'runtime-loader'
    | 'runtime-dependency'
    | 'node-major-branch'
    | 'direct-typescript-launch'
    | 'inventory-contract'
    | 'compiler-contract'
    | 'non-erasable-syntax';
  readonly message: string;
}

export interface RuntimePolicyReport {
  readonly inventory: readonly LaunchInventoryEntry[];
  readonly violations: readonly RuntimePolicyViolation[];
}

interface InventoryContract {
  readonly schemaVersion: number;
  readonly issue: string;
  readonly canonicalRuntime: {
    readonly nodeMajor: number;
    readonly versionFile: string;
    readonly nativeArgvPrefix: readonly string[];
  };
  readonly historicalPathPrefixes: readonly string[];
  readonly requiredLiveSurfaces: readonly {
    readonly path: string;
    readonly classification: Exclude<LaunchClassification, 'historical-fixture-only' | 'invalid'>;
  }[];
}

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
}

const INVENTORY_PATH = 'scripts/toolchain/typescript-launch-inventory.json';
const POLICY_PATH = 'scripts/toolchain/check-typescript-runtime-policy.ts';
const WALK_ROOTS = ['package.json', 'agent-orchestrator.yaml.example', '.github', 'docs', 'scripts', 'tests'] as const;
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', '.ao', 'node_modules', 'vendor']);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.json', '.md', '.mjs', '.mts', '.ps1', '.sh', '.ts', '.txt', '.yaml', '.yml',
]);

function normalizePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//u, '');
}

function extension(path: string): string {
  const name = path.split('/').pop() ?? path;
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function walkFiles(repoRoot: string, absolute: string): string[] {
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  const basename = absolute.split(/[\\/]/u).pop() ?? '';
  if (SKIPPED_DIRECTORY_NAMES.has(basename)) return [];
  const relativePath = normalizePath(relative(repoRoot, absolute));
  if (relativePath === 'packages/core' || relativePath.startsWith('packages/core/')) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => walkFiles(repoRoot, join(absolute, entry.name)));
}

function repositoryTextFiles(repoRoot: string): string[] {
  return WALK_ROOTS
    .flatMap((root) => walkFiles(repoRoot, resolve(repoRoot, root)))
    .filter((absolute) => {
      const path = normalizePath(relative(repoRoot, absolute));
      return path === 'scripts/gh' || path === 'agent-orchestrator.yaml.example' || TEXT_EXTENSIONS.has(extension(path));
    })
    .sort();
}

function historicalPath(path: string, contract: InventoryContract): boolean {
  return contract.historicalPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || path === 'tests'
    || path.startsWith('tests/')
    || path.includes('/fixtures/')
    || /\.test\.(?:[cm]?ts|[cm]?js)$/u.test(path)
    || path.endsWith('.fixture.ts')
    || path.endsWith('.fixture.txt');
}

function clippedEvidence(line: string): string {
  const value = line.trim().replace(/\s+/gu, ' ');
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

function directTypeScriptLaunch(line: string): boolean {
  return /(?:^|[\s"'`:=])node(?:\.exe)?\s+[^\r\n]*?\.(?:[cm]?ts)\b/u.test(line);
}

function nativeTypeScriptLaunch(line: string): boolean {
  return directTypeScriptLaunch(line) && line.includes('--experimental-strip-types');
}

function testFrameworkLaunch(line: string): boolean {
  return /\bvitest\b/u.test(line) && /\.(?:[cm]?ts)\b/u.test(line);
}

function loaderMachinery(line: string): boolean {
  const lowered = line.toLowerCase();
  const typescriptRuntime = lowered.includes('.ts')
    || lowered.includes('typescript')
    || lowered.includes('tsx')
    || lowered.includes('ts-node');
  return typescriptRuntime && (lowered.includes('--loader') || lowered.includes('--import'));
}

function versionDependentLaunchMachinery(source: string): boolean {
  const mentionsVersion = /\bnodeMajor\b|\$nodeMajor\b|process\.versions\.node/u.test(source);
  const conditional = /\bif\b|\?/u.test(source);
  const launchMachinery = source.includes('--experimental-strip-types')
    && (source.includes('--loader') || source.includes('ts-node') || source.includes('tsx'));
  return mentionsVersion && conditional && launchMachinery;
}

function classifyLaunches(
  repoRoot: string,
  files: readonly string[],
  contract: InventoryContract,
): { inventory: LaunchInventoryEntry[]; violations: RuntimePolicyViolation[] } {
  const inventory: LaunchInventoryEntry[] = [];
  const violations: RuntimePolicyViolation[] = [];
  const retiredLoaderName = ['typescript', 'loader.mjs'].join('-');
  const retiredLoaderPath = `scripts/toolchain/${retiredLoaderName}`;

  if (existsSync(resolve(repoRoot, retiredLoaderPath))) {
    violations.push({
      path: retiredLoaderPath,
      line: 1,
      rule: 'runtime-loader',
      message: 'Node-below-22 TypeScript compatibility loader must not exist.',
    });
  }

  for (const absolute of files) {
    const path = normalizePath(relative(repoRoot, absolute));
    const source = readFileSync(absolute, 'utf8');
    const isHistorical = historicalPath(path, contract);
    const lines = source.split(/\r?\n/u);

    if (path !== POLICY_PATH && source.includes(retiredLoaderPath)) {
      violations.push({
        path,
        line: 1,
        rule: 'runtime-loader',
        message: `retired compatibility loader reference must be removed: ${retiredLoaderPath}`,
      });
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const lineNumber = index + 1;
      if (line.includes('Get-OpkTypeScriptNodeArguments')) {
        inventory.push({
          path,
          line: lineNumber,
          classification: isHistorical ? 'historical-fixture-only' : 'powershell-bridge',
          evidence: clippedEvidence(line),
        });
      }
      if (testFrameworkLaunch(line)) {
        inventory.push({
          path,
          line: lineNumber,
          classification: isHistorical ? 'historical-fixture-only' : 'test-framework-owned',
          evidence: clippedEvidence(line),
        });
      }
      if (directTypeScriptLaunch(line)) {
        const classification: LaunchClassification = isHistorical
          ? 'historical-fixture-only'
          : nativeTypeScriptLaunch(line)
            ? 'native-node-22'
            : 'invalid';
        inventory.push({ path, line: lineNumber, classification, evidence: clippedEvidence(line) });
        if (classification === 'invalid') {
          violations.push({
            path,
            line: lineNumber,
            rule: 'direct-typescript-launch',
            message: 'Direct TypeScript launches must use native Node 22 type stripping or the PowerShell bridge.',
          });
        }
      }
      if (path !== POLICY_PATH && loaderMachinery(line) && !isHistorical) {
        violations.push({
          path,
          line: lineNumber,
          rule: 'runtime-loader',
          message: 'Custom TypeScript loaders/import hooks are forbidden; use native Node 22 type stripping.',
        });
      }
    }

    if (path !== POLICY_PATH && !isHistorical && versionDependentLaunchMachinery(source)) {
      violations.push({
        path,
        line: 1,
        rule: 'node-major-branch',
        message: 'Node-major conditionals must not select different TypeScript execution machinery.',
      });
    }
  }

  return { inventory, violations };
}

function loadInventoryContract(repoRoot: string): InventoryContract {
  const value = JSON.parse(readFileSync(resolve(repoRoot, INVENTORY_PATH), 'utf8')) as InventoryContract;
  if (value.schemaVersion !== 1 || value.issue !== '#900' || !Array.isArray(value.requiredLiveSurfaces)) {
    throw new Error(`${INVENTORY_PATH} has an invalid schema or issue owner`);
  }
  return value;
}

function packageViolations(repoRoot: string): RuntimePolicyViolation[] {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
  const violations: RuntimePolicyViolation[] = [];
  const forbiddenPackages = [['t', 'sx'].join(''), ['ts', 'node'].join('-')];
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const name of forbiddenPackages) {
    if (dependencies[name]) {
      violations.push({
        path: 'package.json',
        line: 1,
        rule: 'runtime-dependency',
        message: `TypeScript runtime dependency ${name} is forbidden.`,
      });
    }
  }
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (name === 'check:node-major') continue;
    const executesTypeScript = directTypeScriptLaunch(command) || /\bvitest\b/u.test(command);
    if (executesTypeScript && !command.includes('check:node-major')) {
      violations.push({
        path: 'package.json',
        line: 1,
        rule: 'node-contract',
        message: `npm script ${name} executes TypeScript without the canonical Node-major preflight.`,
      });
    }
  }
  return violations;
}

function compilerViolations(repoRoot: string): RuntimePolicyViolation[] {
  const config = JSON.parse(readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8')) as {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
  };
  const options = config.compilerOptions ?? {};
  const expected: Readonly<Record<string, unknown>> = {
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  };
  return Object.entries(expected).flatMap(([name, value]) => options[name] === value ? [] : [{
    path: 'tsconfig.base.json',
    line: 1,
    rule: 'compiler-contract' as const,
    message: `compilerOptions.${name} must equal ${JSON.stringify(value)}.`,
  }]);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function productionTypeScriptPath(path: string, contract: InventoryContract): boolean {
  return /\.(?:[cm]?ts)$/u.test(path)
    && !path.endsWith('.test.ts')
    && !path.endsWith('.d.ts')
    && !path.endsWith('.d.mts')
    && !historicalPath(path, contract);
}

function nonErasableSyntaxViolations(
  repoRoot: string,
  files: readonly string[],
  contract: InventoryContract,
): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  for (const absolute of files) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (!productionTypeScriptPath(path, contract)) continue;
    const sourceText = readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, construct: string): void => {
      const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        path,
        line: point.line + 1,
        rule: 'non-erasable-syntax',
        message: `${construct} requires TypeScript transformation and is forbidden in production source.`,
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isEnumDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) add(node, 'runtime enum');
      if (ts.isModuleDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) add(node, 'runtime namespace/module');
      if (ts.isImportEqualsDeclaration(node)) add(node, 'import assignment');
      if (ts.isParameter(node)
        && node.parent
        && ts.isConstructorDeclaration(node.parent)
        && node.modifiers?.some((modifier) => [
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.ReadonlyKeyword,
        ].includes(modifier.kind))) {
        add(node, 'parameter property');
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function inventoryContractViolations(
  repoRoot: string,
  contract: InventoryContract,
  inventory: readonly LaunchInventoryEntry[],
): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  if (contract.canonicalRuntime.nodeMajor !== SUPPORTED_NODE_MAJOR
    || contract.canonicalRuntime.versionFile !== NODE_VERSION_FILE
    || contract.canonicalRuntime.nativeArgvPrefix.join(' ') !== '--experimental-strip-types') {
    violations.push({
      path: INVENTORY_PATH,
      line: 1,
      rule: 'inventory-contract',
      message: 'launch inventory canonical runtime does not match the repository-owned Node 22 contract.',
    });
  }
  for (const required of contract.requiredLiveSurfaces) {
    if (!existsSync(resolve(repoRoot, required.path))) {
      violations.push({
        path: INVENTORY_PATH,
        line: 1,
        rule: 'inventory-contract',
        message: `required launch surface is missing: ${required.path}`,
      });
      continue;
    }
    if (!inventory.some((entry) => entry.path === required.path && entry.classification === required.classification)) {
      violations.push({
        path: required.path,
        line: 1,
        rule: 'inventory-contract',
        message: `required launch surface is not classified as ${required.classification}.`,
      });
    }
  }
  return violations;
}

export function checkTypeScriptRuntimePolicy(repoRoot = resolve('.')): RuntimePolicyReport {
  const root = resolve(repoRoot);
  const violations: RuntimePolicyViolation[] = [];
  try {
    assertNodeRuntimeContract(root);
  } catch (error) {
    violations.push({
      path: NODE_VERSION_FILE,
      line: 1,
      rule: 'node-contract',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const contract = loadInventoryContract(root);
  const files = repositoryTextFiles(root);
  const launches = classifyLaunches(root, files, contract);
  violations.push(
    ...launches.violations,
    ...packageViolations(root),
    ...compilerViolations(root),
    ...nonErasableSyntaxViolations(root, files, contract),
    ...inventoryContractViolations(root, contract, launches.inventory),
  );

  const unique = new Map<string, RuntimePolicyViolation>();
  for (const violation of violations) {
    unique.set(`${violation.path}:${violation.line}:${violation.rule}:${violation.message}`, violation);
  }
  return {
    inventory: launches.inventory.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    violations: [...unique.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule)),
  };
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const report = checkTypeScriptRuntimePolicy();
  if (process.argv.includes('--inventory')) {
    process.stdout.write(`${JSON.stringify(report.inventory, null, 2)}\n`);
  }
  if (report.violations.length > 0) {
    for (const violation of report.violations) {
      process.stderr.write(`${violation.path}:${violation.line} ${violation.rule}: ${violation.message}\n`);
    }
    process.exitCode = 1;
  } else if (!process.argv.includes('--inventory')) {
    process.stdout.write('Node 22 TypeScript runtime policy checks passed.\n');
  }
}
