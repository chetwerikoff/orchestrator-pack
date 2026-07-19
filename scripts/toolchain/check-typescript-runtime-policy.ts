import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { assertNodeRuntimeContract, SUPPORTED_NODE_MAJOR } from './node-runtime-contract.mjs';

export type LaunchClassification = 'native-node-22' | 'powershell-bridge' | 'test-framework-owned'
  | 'historical-fixture-only' | 'grandfathered-legacy-runtime' | 'invalid';
export interface LaunchInventoryEntry { readonly path: string; readonly line: number; readonly classification: LaunchClassification; readonly evidence: string }
export interface RuntimePolicyViolation {
  readonly path: string; readonly line: number;
  readonly rule: 'node-contract' | 'runtime-loader' | 'runtime-dependency' | 'node-major-branch'
    | 'direct-typescript-launch' | 'inventory-contract' | 'compiler-contract' | 'non-erasable-syntax';
  readonly message: string;
}
export interface RuntimePolicyReport { readonly inventory: readonly LaunchInventoryEntry[]; readonly violations: readonly RuntimePolicyViolation[] }
interface LegacyLaunch { readonly path: string; readonly line: number; readonly evidence: string }
interface LegacyDependency { readonly path: string; readonly package: string }
interface InventoryContract {
  readonly schemaVersion: number; readonly issue: string;
  readonly canonicalRuntime: { readonly nodeMajor: number; readonly versionFile: string; readonly nativeArgvPrefix: readonly string[] };
  readonly historicalPathPrefixes: readonly string[];
  readonly requiredLiveSurfaces: readonly { readonly path: string; readonly classification: Exclude<LaunchClassification, 'historical-fixture-only' | 'grandfathered-legacy-runtime' | 'invalid'> }[];
  readonly grandfatheredLegacyRuntime?: { readonly launchLines?: readonly LegacyLaunch[]; readonly runtimeDependencies?: readonly LegacyDependency[] };
}
interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>; readonly bin?: string | Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>; readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}
interface LegacyTracker { readonly launches: ReadonlySet<string>; readonly dependencies: ReadonlySet<string>; readonly seenLaunches: Set<string>; readonly seenDependencies: Set<string> }

const INVENTORY = 'scripts/toolchain/typescript-launch-inventory.json';
const POLICY = 'scripts/toolchain/check-typescript-runtime-policy.ts';
const POLICY_TEST = 'scripts/toolchain/node22-runtime-policy.spec.ts';
const ROOTS = ['package.json', 'agent-orchestrator.yaml.example', '.github', 'docs', 'plugins', 'scripts', 'tests'] as const;
const SKIP_DIRS = new Set(['.git', '.ao', 'node_modules', 'vendor']);
const TEXT = new Set(['.cjs', '.cts', '.js', '.json', '.md', '.mjs', '.mts', '.ps1', '.sh', '.ts', '.txt', '.yaml', '.yml']);
const FORBIDDEN_PACKAGES = [['t', 'sx'].join(''), ['ts', 'node'].join('-')] as const;
const retiredLoader = `scripts/toolchain/${['typescript', 'loader.mjs'].join('-')}`;

function norm(value: string): string { return value.split(sep).join('/').replace(/^\.\//u, '') }
function ext(path: string): string { const name = path.split('/').pop() ?? path; const at = name.lastIndexOf('.'); return at < 0 ? '' : name.slice(at) }
function walk(root: string, absolute: string): string[] {
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute); if (stat.isFile()) return [absolute];
  const name = absolute.split(/[\\/]/u).pop() ?? ''; if (SKIP_DIRS.has(name)) return [];
  const rel = norm(relative(root, absolute)); if (rel === 'packages/core' || rel.startsWith('packages/core/')) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => walk(root, join(absolute, entry.name)));
}
function files(root: string): string[] {
  return ROOTS.flatMap((entry) => walk(root, resolve(root, entry))).filter((absolute) => {
    const path = norm(relative(root, absolute)); return path === 'scripts/gh' || path === 'agent-orchestrator.yaml.example' || TEXT.has(ext(path));
  }).sort();
}
function historical(path: string, contract: InventoryContract): boolean {
  return contract.historicalPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || path === 'tests' || path.startsWith('tests/') || path.includes('/fixtures/')
    || /\.(?:test|spec)\.(?:[cm]?ts|[cm]?js)$/u.test(path) || path.endsWith('.fixture.ts')
    || path.endsWith('.fixture.txt') || path.endsWith('.manifest.json') || path.endsWith('.base-anchor.json');
}
function policyFixture(path: string): boolean { return path === POLICY || path === POLICY_TEST || path === INVENTORY || path.startsWith('scripts/toolchain/fixtures/') }
function evidence(line: string): string { const value = line.trim().replace(/\s+/gu, ' '); return value.length <= 180 ? value : `${value.slice(0, 177)}...` }
function launchKey(path: string, line: number, text: string): string { return `${path}\0${line}\0${text}` }
function dependencyKey(path: string, packageName: string): string { return `${path}\0${packageName}` }
function tracker(contract: InventoryContract): LegacyTracker {
  return {
    launches: new Set((contract.grandfatheredLegacyRuntime?.launchLines ?? []).map((x) => launchKey(norm(x.path), x.line, evidence(x.evidence)))),
    dependencies: new Set((contract.grandfatheredLegacyRuntime?.runtimeDependencies ?? []).map((x) => dependencyKey(norm(x.path), x.package))),
    seenLaunches: new Set(), seenDependencies: new Set(),
  };
}
function nativeShebang(line: string): boolean { return /^#!\/usr\/bin\/env\s+-S\s+node\s+--experimental-strip-types\s*$/u.test(line.trim()) }
function directLaunch(line: string): boolean { return /(?:^|[\s"'`:=&|])node(?:\.exe)?\s+[^\r\n]*?\.(?:[cm]?ts)\b/u.test(line) }
function nativeLaunch(line: string): boolean { return nativeShebang(line) || (directLaunch(line) && line.includes('--experimental-strip-types')) }
function vitestLaunch(line: string): boolean { return /\bvitest\b/u.test(line) && (/\.(?:[cm]?ts)\b/u.test(line) || /vitest[^\s]*\.config/u.test(line)) }
function forbiddenLauncher(line: string): boolean {
  const value = line.toLowerCase();
  return /--loader\b/u.test(value) || /--import(?:\s+|['"],\s*['"])(?:tsx|[^\s'",]*loader)/u.test(value)
    || /\bnpx\s+tsx\b/u.test(value) || /node_modules[/\\]\.bin[/\\]tsx\b/u.test(value)
    || /^#!\/usr\/bin\/env\s+tsx\s*$/u.test(value.trim()) || /tsx\/(?:cli|dist\/loader)/u.test(value)
    || /(?:^|["'=(&|])\s*(?:npx\s+)?ts-node(?=\s)/u.test(value);
}
function versionBranch(source: string): boolean {
  return (/\bnodeMajor\b|\$nodeMajor\b|process\.versions\.node/u.test(source)) && (/\bif\b|\?/u.test(source))
    && source.includes('--experimental-strip-types') && forbiddenLauncher(source);
}
function loadContract(root: string): InventoryContract {
  const value = JSON.parse(readFileSync(resolve(root, INVENTORY), 'utf8')) as InventoryContract;
  if (value.schemaVersion !== 1 || value.issue !== '#900' || !Array.isArray(value.requiredLiveSurfaces)
    || (value.grandfatheredLegacyRuntime?.launchLines !== undefined && !Array.isArray(value.grandfatheredLegacyRuntime.launchLines))
    || (value.grandfatheredLegacyRuntime?.runtimeDependencies !== undefined && !Array.isArray(value.grandfatheredLegacyRuntime.runtimeDependencies))) {
    throw new Error(`${INVENTORY} has an invalid schema or issue owner`);
  }
  return value;
}
function scanLaunches(root: string, allFiles: readonly string[], contract: InventoryContract, legacy: LegacyTracker) {
  const inventory: LaunchInventoryEntry[] = []; const violations: RuntimePolicyViolation[] = [];
  if (existsSync(resolve(root, retiredLoader))) violations.push({ path: retiredLoader, line: 1, rule: 'runtime-loader', message: 'Node-below-22 TypeScript compatibility loader must not exist.' });
  for (const absolute of allFiles) {
    const path = norm(relative(root, absolute)); const source = readFileSync(absolute, 'utf8');
    const old = historical(path, contract); const fixture = policyFixture(path); const lines = source.split(/\r?\n/u);
    const directRuntime = !old && !fixture && lines.some((line) => directLaunch(line) || nativeShebang(line) || forbiddenLauncher(line));
    const fileGrandfathered = lines.some((line, index) => legacy.launches.has(launchKey(path, index + 1, evidence(line))));
    if (!old && !fixture && source.includes(retiredLoader)) violations.push({ path, line: 1, rule: 'runtime-loader', message: `retired compatibility loader reference must be removed: ${retiredLoader}` });
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''; const lineNo = index + 1; if (fixture) continue;
      const text = evidence(line); const key = launchKey(path, lineNo, text); const allowed = legacy.launches.has(key);
      const oldClass = old ? 'historical-fixture-only' as const : undefined; let recorded = false;
      if (line.includes('Get-OpkTypeScriptNodeArguments')) { inventory.push({ path, line: lineNo, classification: oldClass ?? 'powershell-bridge', evidence: text }); recorded = true }
      if (vitestLaunch(line)) { inventory.push({ path, line: lineNo, classification: oldClass ?? 'test-framework-owned', evidence: text }); recorded = true }
      if (directLaunch(line) || nativeShebang(line)) {
        const classification: LaunchClassification = oldClass ?? (nativeLaunch(line) ? 'native-node-22' : allowed ? 'grandfathered-legacy-runtime' : 'invalid');
        inventory.push({ path, line: lineNo, classification, evidence: text }); recorded = true;
        if (allowed) legacy.seenLaunches.add(key);
        if (classification === 'invalid') violations.push({ path, line: lineNo, rule: 'direct-typescript-launch', message: 'Direct TypeScript launches must use native Node 22 type stripping or a frozen grandfathered line.' });
      }
      if (!old && forbiddenLauncher(line)) {
        if (allowed) { legacy.seenLaunches.add(key); if (!recorded) inventory.push({ path, line: lineNo, classification: 'grandfathered-legacy-runtime', evidence: text }) }
        else violations.push({ path, line: lineNo, rule: 'runtime-loader', message: 'New custom TypeScript loaders and alternate runtime launchers are forbidden; use native Node 22 type stripping.' });
      }
      const major = !old && directRuntime ? /\bnode-version:\s*['"]?(\d+)/u.exec(line)?.[1] : undefined;
      if (major && Number(major) !== SUPPORTED_NODE_MAJOR && !fileGrandfathered) violations.push({ path, line: lineNo, rule: 'node-contract', message: `CI Node declaration must be ${SUPPORTED_NODE_MAJOR}; received ${major}.` });
    }
    if (!old && !fixture && versionBranch(source)) violations.push({ path, line: 1, rule: 'node-major-branch', message: 'Node-major conditionals must not select different TypeScript execution machinery.' });
  }
  return { inventory, violations };
}
function packageViolations(root: string, allFiles: readonly string[], legacy: LegacyTracker): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  for (const absolute of allFiles) {
    const path = norm(relative(root, absolute)); if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    let manifest: PackageManifest; try { manifest = JSON.parse(readFileSync(absolute, 'utf8')) as PackageManifest }
    catch (error) { violations.push({ path, line: 1, rule: 'runtime-dependency', message: `cannot parse package manifest: ${error instanceof Error ? error.message : String(error)}` }); continue }
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
    for (const name of FORBIDDEN_PACKAGES) if (dependencies[name]) {
      const key = dependencyKey(path, name); if (legacy.dependencies.has(key)) legacy.seenDependencies.add(key);
      else violations.push({ path, line: 1, rule: 'runtime-dependency', message: `New TypeScript runtime dependency ${name} is forbidden.` });
    }
    const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const bin of bins) if (/\.(?:[cm]?ts)$/u.test(bin)) {
      const absoluteBin = resolve(root, path === 'package.json' ? bin : join(dirname(path), bin));
      if (!existsSync(absoluteBin)) { violations.push({ path, line: 1, rule: 'inventory-contract', message: `TypeScript bin target is missing: ${bin}` }); continue }
      const first = readFileSync(absoluteBin, 'utf8').split(/\r?\n/u)[0] ?? ''; if (nativeShebang(first)) continue;
      const key = launchKey(norm(relative(root, absoluteBin)), 1, evidence(first));
      if (legacy.launches.has(key)) legacy.seenLaunches.add(key); else violations.push({ path, line: 1, rule: 'direct-typescript-launch', message: `TypeScript bin ${bin} must use the native Node 22 shebang.` });
    }
  }
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest;
  for (const [name, command] of Object.entries(rootManifest.scripts ?? {})) {
    const testFrameworkOwned = /\bvitest\b/u.test(command) || command.includes('run-vitest-with-harness.mjs');
    if (name !== 'check:node-major' && directLaunch(command) && !testFrameworkOwned && !command.includes('check:node-major'))
      violations.push({ path: 'package.json', line: 1, rule: 'node-contract', message: `npm script ${name} executes TypeScript without the canonical Node-major preflight.` });
  }
  return violations;
}
function compilerViolations(root: string): RuntimePolicyViolation[] {
  const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')) as { compilerOptions?: Readonly<Record<string, unknown>> };
  const expected: Readonly<Record<string, unknown>> = { erasableSyntaxOnly: true, verbatimModuleSyntax: true, module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true };
  return Object.entries(expected).flatMap(([name, value]) => config.compilerOptions?.[name] === value ? [] : [{ path: 'tsconfig.base.json', line: 1, rule: 'compiler-contract' as const, message: `compilerOptions.${name} must equal ${JSON.stringify(value)}.` }]);
}
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean { return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((x) => x.kind === kind) === true }
function syntaxViolations(root: string, allFiles: readonly string[], contract: InventoryContract): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  for (const absolute of allFiles) {
    const path = norm(relative(root, absolute));
    if (!/\.(?:[cm]?ts)$/u.test(path) || /\.(?:test|spec)\.ts$/u.test(path) || path.endsWith('.d.ts') || path.endsWith('.d.mts') || historical(path, contract)) continue;
    const file = ts.createSourceFile(path, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, construct: string) => { const point = file.getLineAndCharacterOfPosition(node.getStart(file)); violations.push({ path, line: point.line + 1, rule: 'non-erasable-syntax', message: `${construct} requires TypeScript transformation and is forbidden in production source.` }) };
    const visit = (node: ts.Node): void => {
      if (ts.isEnumDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) add(node, 'runtime enum');
      if (ts.isModuleDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) add(node, 'runtime namespace/module');
      if (ts.isImportEqualsDeclaration(node)) add(node, 'import assignment');
      if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && node.modifiers?.some((x) => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(x.kind))) add(node, 'parameter property');
      ts.forEachChild(node, visit);
    }; visit(file);
  }
  return violations;
}
function inventoryViolations(root: string, contract: InventoryContract, inventory: readonly LaunchInventoryEntry[], legacy: LegacyTracker): RuntimePolicyViolation[] {
  const violations: RuntimePolicyViolation[] = [];
  if (contract.canonicalRuntime.nodeMajor !== SUPPORTED_NODE_MAJOR || contract.canonicalRuntime.versionFile !== 'package.json' || contract.canonicalRuntime.nativeArgvPrefix.join(' ') !== '--experimental-strip-types')
    violations.push({ path: INVENTORY, line: 1, rule: 'inventory-contract', message: 'launch inventory canonical runtime does not match the repository-owned Node 22 contract.' });
  for (const required of contract.requiredLiveSurfaces) {
    if (!existsSync(resolve(root, required.path))) violations.push({ path: INVENTORY, line: 1, rule: 'inventory-contract', message: `required launch surface is missing: ${required.path}` });
    else if (!inventory.some((entry) => entry.path === required.path && entry.classification === required.classification)) violations.push({ path: required.path, line: 1, rule: 'inventory-contract', message: `required launch surface is not classified as ${required.classification}.` });
  }
  for (const key of legacy.launches) if (!legacy.seenLaunches.has(key)) { const [path, line, text] = key.split('\0'); violations.push({ path: path ?? INVENTORY, line: Number(line) || 1, rule: 'inventory-contract', message: `stale grandfathered runtime launch entry: ${text ?? '<missing evidence>'}` }) }
  for (const key of legacy.dependencies) if (!legacy.seenDependencies.has(key)) { const [path, name] = key.split('\0'); violations.push({ path: path ?? INVENTORY, line: 1, rule: 'inventory-contract', message: `stale grandfathered runtime dependency entry: ${name ?? '<missing package>'}` }) }
  return violations;
}

export function checkTypeScriptRuntimePolicy(repoRoot = resolve('.')): RuntimePolicyReport {
  const root = resolve(repoRoot); const violations: RuntimePolicyViolation[] = [];
  try { assertNodeRuntimeContract(root) } catch (error) { violations.push({ path: 'package.json', line: 1, rule: 'node-contract', message: error instanceof Error ? error.message : String(error) }) }
  const contract = loadContract(root); const legacy = tracker(contract); const allFiles = files(root); const launches = scanLaunches(root, allFiles, contract, legacy);
  violations.push(...launches.violations, ...packageViolations(root, allFiles, legacy), ...compilerViolations(root), ...syntaxViolations(root, allFiles, contract), ...inventoryViolations(root, contract, launches.inventory, legacy));
  const unique = new Map<string, RuntimePolicyViolation>(); for (const item of violations) unique.set(`${item.path}:${item.line}:${item.rule}:${item.message}`, item);
  return { inventory: launches.inventory.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), violations: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule)) };
}
if (isDirectExecution(import.meta.url, process.argv[1])) {
  const report = checkTypeScriptRuntimePolicy(); if (process.argv.includes('--inventory')) process.stdout.write(`${JSON.stringify(report.inventory, null, 2)}\n`);
  if (report.violations.length) { for (const item of report.violations) process.stderr.write(`${item.path}:${item.line} ${item.rule}: ${item.message}\n`); process.exitCode = 1 }
  else if (!process.argv.includes('--inventory')) process.stdout.write('Node 22 TypeScript runtime policy checks passed.\n');
}
