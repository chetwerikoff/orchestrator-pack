import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import {
  assertNodeRuntimeContract,
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
    | 'workflow-node-version'
    | 'runtime-loader'
    | 'runtime-dependency'
    | 'node-major-branch'
    | 'direct-typescript-launch'
    | 'runtime-import-specifier'
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
  readonly workflowFiles: readonly string[];
  readonly requiredLiveSurfaces: readonly {
    readonly path: string;
    readonly classification: Exclude<LaunchClassification, 'historical-fixture-only' | 'invalid'>;
  }[];
}

interface PackageManifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
}

interface WorkspacePackage {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: PackageManifest;
}

const INVENTORY_PATH = 'scripts/toolchain/typescript-launch-inventory.json';
const POLICY_PATH = 'scripts/toolchain/check-typescript-runtime-policy.ts';
const POLICY_TEST_PATH = 'scripts/toolchain/node22-runtime-policy.spec.ts';
const ROOTS = ['package.json', 'agent-orchestrator.yaml.example', '.github', 'docs', 'plugins', 'scripts', 'tests'] as const;
const SKIP_DIRS = new Set(['.git', '.ao', 'node_modules', 'vendor']);
const TEXT_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.json', '.md', '.mjs', '.mts', '.ps1', '.sh', '.ts', '.txt', '.yaml', '.yml']);
const FORBIDDEN_RUNTIME_PACKAGES = ['tsx', 'ts-node'] as const;
const RETIRED_LOADER = 'scripts/toolchain/typescript-loader.mjs';
const RETIRED_POWERSHELL_BRIDGE = 'scripts/lib/Invoke-TypeScriptCli.ps1';
const TYPESCRIPT_CLI_LAUNCHER = 'scripts/lib/Invoke-TypeScriptCli.ts';
const NATIVE_ENTRYPOINT_PREFLIGHT = 'scripts/toolchain/native-entrypoint-preflight.ts';
const NATIVE_TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;
const RUNTIME_JS_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;
const TEST_FRAMEWORK_PATHS = new Set([
  'scripts/vitest-global-setup.ts',
  'scripts/orchestrator-wake-supervisor-orphan-integration.shared.ts',
  'scripts/orchestrator-wake-supervisor.shared.ts',
  'scripts/supervisor-degraded-backoff.shared.ts',
  'scripts/supervisor-fault-boundary.shared.ts',
]);

function normalizePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//u, '');
}

function walk(repoRoot: string, absolute: string): string[] {
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  const name = absolute.split(/[\\/]/u).pop() ?? '';
  if (SKIP_DIRS.has(name)) return [];
  const path = normalizePath(relative(repoRoot, absolute));
  if (path === 'packages/core' || path.startsWith('packages/core/')) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => walk(repoRoot, join(absolute, entry.name)));
}

function repositoryFiles(repoRoot: string): string[] {
  return ROOTS
    .flatMap((entry) => walk(repoRoot, resolve(repoRoot, entry)))
    .filter((absolute) => {
      const path = normalizePath(relative(repoRoot, absolute));
      return path === 'scripts/gh'
        || path === 'agent-orchestrator.yaml.example'
        || TEXT_EXTENSIONS.has(extname(path));
    })
    .sort();
}

function historical(path: string, contract: InventoryContract): boolean {
  const base = path.split('/').pop() ?? path;
  return TEST_FRAMEWORK_PATHS.has(path)
    || contract.historicalPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || path === 'tests'
    || path.startsWith('tests/')
    || path.includes('/tests/')
    || path.includes('/fixtures/')
    || base.startsWith('_test-')
    || /\.(?:test|spec|cases)\.(?:[cm]?ts|[cm]?js)$/u.test(path)
    || /\.test-(?:setup|helpers)\.(?:[cm]?ts|[cm]?js)$/u.test(path)
    || path.endsWith('.fixture.ts')
    || path.endsWith('.fixture.txt')
    || path.endsWith('.manifest.json')
    || path.endsWith('.base-anchor.json');
}

function policyFixture(path: string): boolean {
  return path === POLICY_PATH
    || path === POLICY_TEST_PATH
    || path === INVENTORY_PATH
    || path.startsWith('scripts/toolchain/fixtures/');
}

function productionTypeScriptPath(path: string, contract: InventoryContract): boolean {
  return /\.(?:[cm]?ts)$/u.test(path)
    && !path.endsWith('.d.ts')
    && !path.endsWith('.d.mts')
    && !historical(path, contract)
    && !policyFixture(path);
}

function compactEvidence(line: string): string {
  const value = line.trim().replace(/\s+/gu, ' ');
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

function nativeShebang(line: string): boolean {
  return /^#!\/usr\/bin\/env\s+-S\s+node\s+--experimental-strip-types\s*$/u.test(line.trim());
}

function directTypeScriptLaunch(line: string): boolean {
  return /(?:^|[\s"'`:=&|])node(?:\.exe)?\s+(?:(?:--[A-Za-z0-9-]+)(?:=[^\s]+)?\s+)*["']?[^\s"'`]+\.(?:[cm]?ts)\b/u.test(line);
}

function directTypeScriptTarget(line: string): string | undefined {
  const match = /(?:^|[\s"'`:=&|])node(?:\.exe)?\s+(?:(?:--[A-Za-z0-9-]+)(?:=[^\s]+)?\s+)*["']?([^\s"'`]+\.(?:[cm]?ts))\b/u.exec(line);
  return match?.[1];
}

function firstImportSpecifier(source: string, path: string): string | undefined {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const first = sourceFile.statements[0];
  return first && ts.isImportDeclaration(first) && ts.isStringLiteralLike(first.moduleSpecifier)
    ? first.moduleSpecifier.text
    : undefined;
}

function hasCanonicalEntrypointPreflight(repoRoot: string, absoluteTarget: string): boolean {
  const targetPath = normalizePath(relative(repoRoot, absoluteTarget));
  if (targetPath === TYPESCRIPT_CLI_LAUNCHER || targetPath === NATIVE_ENTRYPOINT_PREFLIGHT) return true;
  if (!existsSync(absoluteTarget)) return false;
  const source = readFileSync(absoluteTarget, 'utf8');
  const specifier = firstImportSpecifier(source, targetPath);
  if (!specifier || (!specifier.startsWith('./') && !specifier.startsWith('../'))) return false;
  const imported = normalizePath(relative(repoRoot, resolve(dirname(absoluteTarget), specifier)));
  return imported === NATIVE_ENTRYPOINT_PREFLIGHT;
}

function nativeLaunchTarget(
  repoRoot: string,
  sourceAbsolute: string,
  line: string,
): string | undefined {
  if (nativeShebang(line)) return sourceAbsolute;
  if (line.includes(TYPESCRIPT_CLI_LAUNCHER) || line.includes('Invoke-TypeScriptCli.ts')) {
    return resolve(repoRoot, TYPESCRIPT_CLI_LAUNCHER);
  }
  const target = directTypeScriptTarget(line);
  if (!target || /[$`{}]/u.test(target)) return undefined;
  return resolve(repoRoot, target);
}

function nativeTypeScriptLaunch(line: string): boolean {
  return nativeShebang(line)
    || (directTypeScriptLaunch(line) && line.includes('--experimental-strip-types'))
    || (line.includes('runNativeTypeScriptCli') && /\.([cm]?ts)\b/u.test(line));
}

function vitestLaunch(line: string): boolean {
  return /\bvitest\b/u.test(line)
    && (/\.(?:[cm]?ts)\b/u.test(line) || /vitest[^\s]*\.config/u.test(line));
}

function forbiddenRuntimeLauncher(line: string): boolean {
  const value = line.toLowerCase();
  return /--loader\b/u.test(value)
    || /--import(?:\s+|['"],\s*['"])(?:tsx|[^\s'",]*loader)/u.test(value)
    || /\bnpx\s+tsx\b/u.test(value)
    || /node_modules[/\\]\.bin[/\\]tsx\b/u.test(value)
    || /^#!\/usr\/bin\/env\s+tsx\s*$/u.test(value.trim())
    || /tsx\/(?:cli|dist\/loader)/u.test(value)
    || /(?:^|[;&|"'=])\s*tsx\s+[^\r\n]*\.(?:[cm]?ts)\b/u.test(value)
    || /(?:^|[;&|"'=])\s*ts-node\s+[^\r\n]*\.(?:[cm]?ts)\b/u.test(value);
}

function versionMachineryBranch(source: string): boolean {
  return (/\bnodeMajor\b|\$nodeMajor\b|process\.versions\.node/u.test(source))
    && (/\bif\b|\?/u.test(source))
    && source.includes('--experimental-strip-types')
    && forbiddenRuntimeLauncher(source);
}

function loadInventoryContract(repoRoot: string): InventoryContract {
  const value = JSON.parse(readFileSync(resolve(repoRoot, INVENTORY_PATH), 'utf8')) as InventoryContract;
  if (value.schemaVersion !== 1
    || value.issue !== '#900'
    || !Array.isArray(value.workflowFiles)
    || !Array.isArray(value.requiredLiveSurfaces)
    || !Array.isArray(value.historicalPathPrefixes)) {
    throw new Error(`${INVENTORY_PATH} has an invalid schema or issue owner`);
  }
  return value;
}

function stripYamlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === '"' && !singleQuoted && line[index - 1] !== '\\') doubleQuoted = !doubleQuoted;
    if (character === '#' && !singleQuoted && !doubleQuoted) return line.slice(0, index);
  }
  return line;
}

function yamlIndent(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function setupNodeStepRange(lines: readonly string[], usesIndex: number): { start: number; end: number } {
  const usesLine = stripYamlComment(lines[usesIndex] ?? '');
  const usesIndent = yamlIndent(usesLine);
  let start = usesIndex;
  let stepIndent = usesIndent;

  if (!/^\s*-\s*uses\s*:/u.test(usesLine)) {
    for (let index = usesIndex - 1; index >= 0; index -= 1) {
      const line = stripYamlComment(lines[index] ?? '');
      if (!line.trim()) continue;
      const match = /^(\s*)-\s+\S/u.exec(line);
      const indentation = match?.[1];
      if (indentation !== undefined && indentation.length <= usesIndent) {
        start = index;
        stepIndent = indentation.length;
        break;
      }
    }
  }

  let end = lines.length;
  for (let index = usesIndex + 1; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] ?? '');
    if (!line.trim()) continue;
    const indent = yamlIndent(line);
    if (indent < stepIndent || (indent === stepIndent && /^\s*-\s+\S/u.test(line))) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function workflowVersionSelectors(
  lines: readonly string[],
  range: { readonly start: number; readonly end: number },
): readonly { readonly kind: 'node-version' | 'node-version-file'; readonly value: string; readonly line: number }[] {
  const selectors: { kind: 'node-version' | 'node-version-file'; value: string; line: number }[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const line = stripYamlComment(lines[index] ?? '');
    const pattern = /\b(node-version-file|node-version)\s*:\s*([^,}\n]+)/gu;
    for (const match of line.matchAll(pattern)) {
      selectors.push({
        kind: match[1] as 'node-version' | 'node-version-file',
        value: (match[2] ?? '').trim(),
        line: index + 1,
      });
    }
  }
  return selectors;
}

function literalNodeMajor(value: string): number | undefined {
  const trimmed = value.trim();
  const unquoted = ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"')))
    ? trimmed.slice(1, -1)
    : trimmed;
  const match = /^(\d+)(?:\.x)?$/u.exec(unquoted);
  return match?.[1] ? Number(match[1]) : undefined;
}

function scanWorkflowNodeVersions(
  repoRoot: string,
  allFiles: readonly string[],
  contract: InventoryContract,
): { inventory: LaunchInventoryEntry[]; violations: RuntimePolicyViolation[] } {
  const inventory: LaunchInventoryEntry[] = [];
  const violations: RuntimePolicyViolation[] = [];
  const setupNodeCounts = new Map<string, number>();

  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) continue;
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripYamlComment(lines[index] ?? '');
      if (!/^\s*(?:-\s*)?uses\s*:\s*['"]?actions\/setup-node@[^'"\s]+['"]?\s*$/u.test(line.trimEnd())) continue;

      setupNodeCounts.set(path, (setupNodeCounts.get(path) ?? 0) + 1);
      const range = setupNodeStepRange(lines, index);
      const selectors = workflowVersionSelectors(lines, range);
      const valid = selectors.length === 1
        && selectors[0]?.kind === 'node-version'
        && literalNodeMajor(selectors[0].value) === SUPPORTED_NODE_MAJOR;
      inventory.push({
        path,
        line: index + 1,
        classification: valid ? 'native-node-22' : 'invalid',
        evidence: compactEvidence(lines.slice(range.start, range.end).join(' ')),
      });

      if (selectors.length === 0) {
        violations.push({
          path,
          line: index + 1,
          rule: 'workflow-node-version',
          message: `actions/setup-node must declare one literal node-version: '${SUPPORTED_NODE_MAJOR}'.`,
        });
        continue;
      }
      if (selectors.length !== 1) {
        violations.push({
          path,
          line: selectors[0]?.line ?? index + 1,
          rule: 'workflow-node-version',
          message: 'actions/setup-node must have exactly one version selector.',
        });
        continue;
      }
      const selector = selectors[0];
      if (!selector) continue;
      if (selector.kind === 'node-version-file') {
        violations.push({
          path,
          line: selector.line,
          rule: 'workflow-node-version',
          message: `node-version-file is not allowed; select literal Node ${SUPPORTED_NODE_MAJOR}.`,
        });
        continue;
      }
      const major = literalNodeMajor(selector.value);
      if (major !== SUPPORTED_NODE_MAJOR) {
        violations.push({
          path,
          line: selector.line,
          rule: 'workflow-node-version',
          message: major === undefined
            ? `actions/setup-node version must be a literal ${SUPPORTED_NODE_MAJOR} or ${SUPPORTED_NODE_MAJOR}.x; received ${JSON.stringify(selector.value)}.`
            : `every live workflow Node declaration must select ${SUPPORTED_NODE_MAJOR}; received ${major}.`,
        });
      }
    }
  }

  for (const path of contract.workflowFiles) {
    if (!existsSync(resolve(repoRoot, path))) {
      violations.push({ path, line: 1, rule: 'inventory-contract', message: 'required workflow file is missing.' });
    } else if ((setupNodeCounts.get(path) ?? 0) === 0) {
      violations.push({ path, line: 1, rule: 'workflow-node-version', message: 'required workflow has no live actions/setup-node step.' });
    }
  }
  return { inventory, violations };
}

function scanLaunches(
  repoRoot: string,
  allFiles: readonly string[],
  contract: InventoryContract,
): { inventory: LaunchInventoryEntry[]; violations: RuntimePolicyViolation[] } {
  const inventory: LaunchInventoryEntry[] = [];
  const violations: RuntimePolicyViolation[] = [];

  if (existsSync(resolve(repoRoot, RETIRED_LOADER))) {
    violations.push({
      path: RETIRED_LOADER,
      line: 1,
      rule: 'runtime-loader',
      message: 'Node-below-22 TypeScript compatibility loader must not exist.',
    });
  }
  if (existsSync(resolve(repoRoot, RETIRED_POWERSHELL_BRIDGE))) {
    violations.push({
      path: RETIRED_POWERSHELL_BRIDGE,
      line: 1,
      rule: 'inventory-contract',
      message: `retired PowerShell TypeScript launcher must not exist; use ${TYPESCRIPT_CLI_LAUNCHER}.`,
    });
  }

  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    const source = readFileSync(absolute, 'utf8');
    const isHistorical = historical(path, contract);
    const fixture = policyFixture(path);
    const lines = source.split(/\r?\n/u);

    if (!isHistorical && !fixture && source.includes(RETIRED_LOADER)) {
      violations.push({
        path,
        line: 1,
        rule: 'runtime-loader',
        message: `retired compatibility loader reference must be removed: ${RETIRED_LOADER}`,
      });
    }
    if (!isHistorical && !fixture && source.includes(RETIRED_POWERSHELL_BRIDGE)) {
      violations.push({
        path,
        line: 1,
        rule: 'inventory-contract',
        message: `retired PowerShell launcher reference must be removed: ${RETIRED_POWERSHELL_BRIDGE}`,
      });
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (fixture) continue;
      const line = lines[index] ?? '';
      const lineNo = index + 1;
      const evidence = compactEvidence(line);
      const oldClass = isHistorical ? 'historical-fixture-only' as const : undefined;

      if (path.endsWith('.ps1') && line.includes(TYPESCRIPT_CLI_LAUNCHER.split('/').pop() ?? TYPESCRIPT_CLI_LAUNCHER)) {
        inventory.push({ path, line: lineNo, classification: oldClass ?? 'powershell-bridge', evidence });
      }
      if (vitestLaunch(line)) {
        inventory.push({ path, line: lineNo, classification: oldClass ?? 'test-framework-owned', evidence });
      }
      if (directTypeScriptLaunch(line) || nativeShebang(line) || line.includes('runNativeTypeScriptCli')) {
        const native = nativeTypeScriptLaunch(line);
        const target = native && path !== 'package.json' && !path.endsWith('/package.json')
          ? nativeLaunchTarget(repoRoot, absolute, line)
          : undefined;
        const preflighted = oldClass !== undefined
          || path === 'package.json'
          || path.endsWith('/package.json')
          || (target !== undefined && hasCanonicalEntrypointPreflight(repoRoot, target));
        const classification: LaunchClassification = oldClass ?? (native && preflighted ? 'native-node-22' : 'invalid');
        inventory.push({ path, line: lineNo, classification, evidence });
        if (classification === 'invalid') {
          violations.push({
            path,
            line: lineNo,
            rule: native ? 'node-contract' : 'direct-typescript-launch',
            message: native
              ? 'direct native TypeScript entrypoints must run the canonical declaration preflight before importing business modules.'
              : 'direct TypeScript launches must use native Node 22 type stripping or the canonical TypeScript launcher.',
          });
        }
      }
      if (forbiddenRuntimeLauncher(line)) {
        inventory.push({ path, line: lineNo, classification: oldClass ?? 'invalid', evidence });
        if (!isHistorical) {
          violations.push({
            path,
            line: lineNo,
            rule: 'runtime-loader',
            message: 'custom loaders, tsx, and ts-node launchers are forbidden; use native Node 22 type stripping.',
          });
        }
      }
    }

    if (!isHistorical && !fixture && versionMachineryBranch(source)) {
      violations.push({
        path,
        line: 1,
        rule: 'node-major-branch',
        message: 'Node-major conditionals must not select different TypeScript execution machinery.',
      });
    }
  }

  const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
  for (const [name, command] of Object.entries(rootManifest.scripts ?? {})) {
    const testFrameworkOwned = /\bvitest\b/u.test(command) || command.includes('run-vitest-with-harness.mjs');
    if (testFrameworkOwned) {
      inventory.push({ path: 'package.json', line: 1, classification: 'test-framework-owned', evidence: `${name}: ${command}` });
      continue;
    }
    if (directTypeScriptLaunch(command)) {
      inventory.push({
        path: 'package.json',
        line: 1,
        classification: nativeTypeScriptLaunch(command) ? 'native-node-22' : 'invalid',
        evidence: `${name}: ${command}`,
      });
      if (name !== 'check:node-major' && !command.includes('check:node-major')) {
        violations.push({
          path: 'package.json',
          line: 1,
          rule: 'node-contract',
          message: `npm script ${name} executes TypeScript without the canonical Node runtime preflight.`,
        });
      }
    }
  }

  return { inventory, violations };
}

function packageViolations(repoRoot: string, allFiles: readonly string[]): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(readFileSync(absolute, 'utf8')) as PackageManifest;
    } catch (error) {
      violations.push({
        path,
        line: 1,
        rule: 'runtime-dependency',
        message: `cannot parse package manifest: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
    for (const name of FORBIDDEN_RUNTIME_PACKAGES) {
      if (dependencies[name]) {
        violations.push({
          path,
          line: 1,
          rule: 'runtime-dependency',
          message: `direct TypeScript runtime dependency ${name} is forbidden.`,
        });
      }
    }
    const packageRoot = path === 'package.json' ? repoRoot : dirname(absolute);
    const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const bin of bins) {
      const absoluteBin = resolve(packageRoot, bin);
      if (!existsSync(absoluteBin)) {
        violations.push({ path, line: 1, rule: 'inventory-contract', message: `bin target is missing: ${bin}` });
        continue;
      }
      const source = readFileSync(absoluteBin, 'utf8');
      if (/\.(?:[cm]?ts)$/u.test(bin)) {
        const first = source.split(/\r?\n/u)[0] ?? '';
        if (!nativeShebang(first)) {
          violations.push({
            path,
            line: 1,
            rule: 'direct-typescript-launch',
            message: `TypeScript bin ${bin} must use the native Node 22 shebang.`,
          });
        }
        if (!hasCanonicalEntrypointPreflight(repoRoot, absoluteBin)) {
          violations.push({
            path,
            line: 1,
            rule: 'node-contract',
            message: `TypeScript bin ${bin} must import ${NATIVE_ENTRYPOINT_PREFLIGHT} before business modules.`,
          });
        }
      } else if (/\.[cm]?js$/u.test(bin) && !source.includes('runNativeTypeScriptCli')) {
        violations.push({
          path,
          line: 1,
          rule: 'direct-typescript-launch',
          message: `JavaScript bin wrapper ${bin} must call the canonical native TypeScript CLI helper.`,
        });
      }
    }
  }
  return violations;
}

function compilerViolations(repoRoot: string): RuntimePolicyViolation[] {
  const config = JSON.parse(readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions?: Readonly<Record<string, unknown>>;
  };
  const expected: Readonly<Record<string, unknown>> = {
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  };
  return Object.entries(expected).flatMap(([name, value]) =>
    config.compilerOptions?.[name] === value
      ? []
      : [{
        path: 'tsconfig.base.json',
        line: 1,
        rule: 'compiler-contract' as const,
        message: `compilerOptions.${name} must equal ${JSON.stringify(value)}.`,
      }]);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function syntaxViolations(
  repoRoot: string,
  allFiles: readonly string[],
  contract: InventoryContract,
): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (!productionTypeScriptPath(path, contract)) continue;
    const sourceFile = ts.createSourceFile(path, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
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
        && ts.isConstructorDeclaration(node.parent)
        && node.modifiers?.some((modifier) => [
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.ReadonlyKeyword,
        ].includes(modifier.kind))) add(node, 'parameter property');
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function workspacePackages(repoRoot: string): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const pluginsRoot = resolve(repoRoot, 'plugins');
  if (!existsSync(pluginsRoot)) return packages;
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = resolve(pluginsRoot, entry.name);
    const manifestPath = resolve(root, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    if (manifest.name) packages.set(manifest.name, { root, manifestPath, manifest });
  }
  return packages;
}

function exportTarget(exportsValue: unknown, subpath: string): string | undefined {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return undefined;
  const exportsRecord = exportsValue as Readonly<Record<string, unknown>>;
  const direct = exportsRecord[subpath];
  const stringTarget = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
      const target = stringTarget(nested);
      if (target) return target;
    }
    return undefined;
  };
  const directTarget = stringTarget(direct);
  if (directTarget) return directTarget;
  for (const [pattern, value] of Object.entries(exportsRecord)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
    const target = stringTarget(value);
    if (target?.includes('*')) return target.replace('*', captured);
  }
  return undefined;
}

function workspaceSpecifierParts(
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): { workspace: WorkspacePackage; subpath: string } | undefined {
  for (const [name, workspace] of packages) {
    if (specifier === name) return { workspace, subpath: '.' };
    if (specifier.startsWith(`${name}/`)) return { workspace, subpath: `./${specifier.slice(name.length + 1)}` };
  }
  return undefined;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): readonly { node: ts.Node; value: string }[] {
  const specifiers: { node: ts.Node; value: string }[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push({ node, value: node.text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function importSpecifierViolations(
  repoRoot: string,
  allFiles: readonly string[],
  contract: InventoryContract,
): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  const packages = workspacePackages(repoRoot);

  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (!productionTypeScriptPath(path, contract)) continue;
    const sourceFile = ts.createSourceFile(path, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const value = specifier.value;
      const point = sourceFile.getLineAndCharacterOfPosition(specifier.node.getStart(sourceFile));
      const line = point.line + 1;
      if (value.startsWith('./') || value.startsWith('../')) {
        const literalTarget = resolve(dirname(absolute), value);
        const extension = extname(value);
        if (NATIVE_TS_EXTENSIONS.includes(extension as typeof NATIVE_TS_EXTENSIONS[number])) {
          if (!existsSync(literalTarget)) {
            violations.push({ path, line, rule: 'runtime-import-specifier', message: `relative TypeScript source does not exist: ${value}` });
          }
          continue;
        }
        if (RUNTIME_JS_EXTENSIONS.includes(extension as typeof RUNTIME_JS_EXTENSIONS[number])) {
          if (existsSync(literalTarget)) continue;
          const sourceCandidates = NATIVE_TS_EXTENSIONS.map((candidate) => resolve(dirname(absolute), `${value.slice(0, -extension.length)}${candidate}`));
          if (sourceCandidates.some((candidate) => existsSync(candidate))) {
            violations.push({
              path,
              line,
              rule: 'runtime-import-specifier',
              message: `loader-dependent relative specifier ${JSON.stringify(value)} resolves only by .js→TypeScript substitution; import the explicit source extension.`,
            });
          }
          continue;
        }
        if (extension && existsSync(literalTarget)) continue;
        violations.push({
          path,
          line,
          rule: 'runtime-import-specifier',
          message: `relative native TypeScript imports require an existing runtime file or an explicit .ts/.mts/.cts source extension: ${JSON.stringify(value)}.`,
        });
        continue;
      }

      if (!value.endsWith('.js')) continue;
      const parts = workspaceSpecifierParts(value, packages);
      if (!parts) continue;
      const target = exportTarget(parts.workspace.manifest.exports, parts.subpath);
      if (!target || !NATIVE_TS_EXTENSIONS.some((extension) => target.endsWith(extension))) {
        violations.push({
          path,
          line,
          rule: 'runtime-import-specifier',
          message: `workspace package specifier ${JSON.stringify(value)} requires an explicit package export mapping to TypeScript source.`,
        });
        continue;
      }
      if (!existsSync(resolve(parts.workspace.root, target))) {
        violations.push({
          path,
          line,
          rule: 'runtime-import-specifier',
          message: `workspace package export for ${JSON.stringify(value)} points to a missing source: ${target}.`,
        });
      }
    }
  }
  return violations;
}

function inventoryViolations(
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
      message: 'launch inventory canonical runtime does not match the toolchain-owned Node 22 contract.',
    });
  }
  for (const required of contract.requiredLiveSurfaces) {
    if (!existsSync(resolve(repoRoot, required.path))) {
      violations.push({ path: INVENTORY_PATH, line: 1, rule: 'inventory-contract', message: `required launch surface is missing: ${required.path}` });
    } else if (!inventory.some((entry) => entry.path === required.path && entry.classification === required.classification)) {
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
  const allFiles = repositoryFiles(root);
  const workflows = scanWorkflowNodeVersions(root, allFiles, contract);
  const launches = scanLaunches(root, allFiles, contract);
  const inventory = [...workflows.inventory, ...launches.inventory];
  violations.push(
    ...workflows.violations,
    ...launches.violations,
    ...packageViolations(root, allFiles),
    ...compilerViolations(root),
    ...syntaxViolations(root, allFiles, contract),
    ...importSpecifierViolations(root, allFiles, contract),
    ...inventoryViolations(root, contract, inventory),
  );

  const unique = new Map<string, RuntimePolicyViolation>();
  for (const violation of violations) {
    unique.set(`${violation.path}:${violation.line}:${violation.rule}:${violation.message}`, violation);
  }
  return {
    inventory: inventory.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    violations: [...unique.values()].sort((left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule)),
  };
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const report = checkTypeScriptRuntimePolicy();
  if (process.argv.includes('--inventory')) process.stdout.write(`${JSON.stringify(report.inventory, null, 2)}\n`);
  if (report.violations.length > 0) {
    for (const violation of report.violations) {
      process.stderr.write(`${violation.path}:${violation.line} ${violation.rule}: ${violation.message}\n`);
    }
    process.exitCode = 1;
  } else if (!process.argv.includes('--inventory')) {
    process.stdout.write('Node 22 TypeScript runtime policy checks passed.\n');
  }
}
