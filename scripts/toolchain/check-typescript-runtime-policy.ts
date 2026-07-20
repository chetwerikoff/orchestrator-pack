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
    | 'non-erasable-syntax'
    | 'agent-runtime-contract';
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
const AGENTS_PATH = 'AGENTS.md';
const AGENTS_NODE_22_RULE = '**Node 22-only TypeScript runtime:**';
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
  return first
    && ts.isImportDeclaration(first)
    && first.importClause === undefined
    && ts.isStringLiteralLike(first.moduleSpecifier)
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

interface WorkflowVersionSelector {
  readonly kind: 'node-version' | 'node-version-file';
  readonly value: string;
  readonly line: number;
}

interface WorkflowSetupNodeStep {
  readonly line: number;
  readonly evidence: string;
  readonly withMappings: number;
  readonly withIsMapping: boolean;
  readonly selectors: readonly WorkflowVersionSelector[];
}

function stripYamlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && doubleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      if (singleQuoted && line[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (character === '#' && !singleQuoted && !doubleQuoted) return line.slice(0, index);
  }
  return line;
}

function yamlIndent(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function yamlScalarValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

interface SimpleYamlPair {
  readonly key: string;
  readonly value: string;
  readonly line: number;
  readonly indent: number;
}

function topLevelColon(text: string): number {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && doubleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      if (singleQuoted && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) continue;
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === ':' && braces === 0 && brackets === 0) return index;
  }
  return -1;
}

function parseSimpleYamlPair(text: string, line: number, indent: number): SimpleYamlPair | undefined {
  const colon = topLevelColon(text);
  if (colon < 0) return undefined;
  const keyRaw = text.slice(0, colon).trim();
  if (!keyRaw) return undefined;
  return {
    key: yamlScalarValue(keyRaw),
    value: text.slice(colon + 1).trim(),
    line,
    indent,
  };
}

function splitFlowItems(text: string): readonly string[] | undefined {
  const items: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && doubleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      if (singleQuoted && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) continue;
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === ',' && braces === 0 && brackets === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
    if (braces < 0 || brackets < 0) return undefined;
  }
  if (singleQuoted || doubleQuoted || escaped || braces !== 0 || brackets !== 0) return undefined;
  items.push(text.slice(start).trim());
  return items;
}

function parseFlowMap(raw: string, line: number): readonly SimpleYamlPair[] | undefined {
  const value = raw.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined;
  const items = splitFlowItems(value.slice(1, -1));
  if (!items) return undefined;
  const pairs: SimpleYamlPair[] = [];
  for (const item of items) {
    if (!item) continue;
    const pair = parseSimpleYamlPair(item, line, 0);
    if (!pair) return undefined;
    pairs.push(pair);
  }
  return pairs;
}

function yamlStepRange(lines: readonly string[], occurrenceIndex: number): { readonly start: number; readonly end: number } | undefined {
  const occurrenceIndent = yamlIndent(lines[occurrenceIndex] ?? '');
  let start = -1;
  let stepIndent = -1;
  for (let index = occurrenceIndex; index >= 0; index -= 1) {
    const line = stripYamlComment(lines[index] ?? '');
    if (!line.trim()) continue;
    const match = /^(\s*)-\s*/u.exec(line);
    if (match && match[1] !== undefined && match[1].length <= occurrenceIndent) {
      start = index;
      stepIndent = match[1].length;
      break;
    }
    if (yamlIndent(line) < occurrenceIndent && /^\s*\S/u.test(line) && !/^\s+/u.test(line)) break;
  }
  if (start < 0) return undefined;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] ?? '');
    if (!line.trim()) continue;
    const indent = yamlIndent(line);
    if (indent < stepIndent || (indent === stepIndent && /^\s*-\s*/u.test(line))) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function parseBlockStepPairs(lines: readonly string[], range: { readonly start: number; readonly end: number }): readonly SimpleYamlPair[] {
  const stepIndent = yamlIndent(lines[range.start] ?? '');
  const expectedIndent = stepIndent + 2;
  const pairs: SimpleYamlPair[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    let line = stripYamlComment(lines[index] ?? '');
    if (!line.trim()) continue;
    let indent = yamlIndent(line);
    let text = line.trimStart();
    if (index === range.start) {
      const dash = /^-\s*(.*)$/u.exec(text);
      if (!dash) continue;
      text = dash[1] ?? '';
      indent = expectedIndent;
      if (!text || text.startsWith('{')) continue;
    }
    if (indent !== expectedIndent) continue;
    const pair = parseSimpleYamlPair(text, index + 1, indent);
    if (pair) pairs.push(pair);
  }
  return pairs;
}

function blockWithSelectors(
  lines: readonly string[],
  range: { readonly start: number; readonly end: number },
  withPair: SimpleYamlPair,
): readonly WorkflowVersionSelector[] {
  if (withPair.value) {
    const flow = parseFlowMap(withPair.value, withPair.line);
    if (!flow) return [];
    return flow
      .filter((pair) => pair.key === 'node-version' || pair.key === 'node-version-file')
      .map((pair) => ({ kind: pair.key as WorkflowVersionSelector['kind'], value: pair.value, line: pair.line }));
  }

  const selectors: WorkflowVersionSelector[] = [];
  const childPairs: SimpleYamlPair[] = [];
  for (let index = withPair.line; index < range.end; index += 1) {
    const line = stripYamlComment(lines[index] ?? '');
    if (!line.trim()) continue;
    const indent = yamlIndent(line);
    if (indent <= withPair.indent) break;
    const pair = parseSimpleYamlPair(line.trimStart(), index + 1, indent);
    if (pair) childPairs.push(pair);
  }
  const childIndent = childPairs.length > 0 ? Math.min(...childPairs.map((pair) => pair.indent)) : undefined;
  for (const pair of childPairs) {
    if (pair.indent !== childIndent) continue;
    if (pair.key !== 'node-version' && pair.key !== 'node-version-file') continue;
    selectors.push({ kind: pair.key, value: pair.value, line: pair.line });
  }
  return selectors;
}

function parseSetupNodeStep(
  lines: readonly string[],
  range: { readonly start: number; readonly end: number },
): WorkflowSetupNodeStep | undefined {
  const first = stripYamlComment(lines[range.start] ?? '').trimStart();
  const flowText = /^-\s*(\{.*\})\s*$/u.exec(first)?.[1];
  let usesPairs: readonly SimpleYamlPair[];
  let withPairs: readonly SimpleYamlPair[];
  let selectors: readonly WorkflowVersionSelector[] = [];
  let withIsMapping = false;

  if (flowText) {
    const pairs = parseFlowMap(flowText, range.start + 1);
    if (!pairs) return undefined;
    usesPairs = pairs.filter((pair) => pair.key === 'uses');
    withPairs = pairs.filter((pair) => pair.key === 'with');
    if (withPairs.length === 1) {
      const nested = parseFlowMap(withPairs[0]?.value ?? '', withPairs[0]?.line ?? range.start + 1);
      if (nested) {
        withIsMapping = true;
        selectors = nested
          .filter((pair) => pair.key === 'node-version' || pair.key === 'node-version-file')
          .map((pair) => ({ kind: pair.key as WorkflowVersionSelector['kind'], value: pair.value, line: pair.line }));
      }
    }
  } else {
    const pairs = parseBlockStepPairs(lines, range);
    usesPairs = pairs.filter((pair) => pair.key === 'uses');
    withPairs = pairs.filter((pair) => pair.key === 'with');
    if (withPairs.length === 1) {
      const withPair = withPairs[0];
      if (withPair) {
        const flow = withPair.value ? parseFlowMap(withPair.value, withPair.line) : undefined;
        withIsMapping = !withPair.value || flow !== undefined;
        selectors = blockWithSelectors(lines, range, withPair);
      }
    }
  }

  if (usesPairs.length !== 1) return undefined;
  const uses = yamlScalarValue(usesPairs[0]?.value ?? '');
  if (!/^actions\/setup-node@[^\s]+$/u.test(uses)) return undefined;
  return {
    line: usesPairs[0]?.line ?? range.start + 1,
    evidence: compactEvidence(lines.slice(range.start, range.end).join(' ')),
    withMappings: withPairs.length,
    withIsMapping,
    selectors,
  };
}

function workflowSetupNodeSteps(
  source: string,
  path: string,
): { readonly steps: readonly WorkflowSetupNodeStep[]; readonly violations: readonly RuntimePolicyViolation[] } {
  const lines = source.split(/\r?\n/u);
  const steps: WorkflowSetupNodeStep[] = [];
  const violations: RuntimePolicyViolation[] = [];
  const seenRanges = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] ?? '');
    if (!line.includes('actions/setup-node@')) continue;
    const range = yamlStepRange(lines, index);
    if (!range) {
      violations.push({
        path,
        line: index + 1,
        rule: 'workflow-node-version',
        message: 'setup-node reference must be expressed as a structurally verifiable workflow step.',
      });
      continue;
    }
    const identity = `${range.start}:${range.end}`;
    if (seenRanges.has(identity)) continue;
    seenRanges.add(identity);
    const step = parseSetupNodeStep(lines, range);
    if (!step) {
      violations.push({
        path,
        line: index + 1,
        rule: 'workflow-node-version',
        message: 'setup-node step could not be parsed unambiguously; use a block or single-line flow mapping with literal uses/with keys.',
      });
      continue;
    }
    steps.push(step);
  }
  return { steps, violations };
}

interface ShellChain {
  readonly segments: readonly string[];
  readonly operators: readonly ('&&' | '||' | ';' | '|' | '&')[];
}

function parseShellChain(command: string): ShellChain | undefined {
  const segments: string[] = [];
  const operators: ('&&' | '||' | ';' | '|' | '&')[] = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) continue;

    const pair = command.slice(index, index + 2);
    const operator = pair === '&&' || pair === '||'
      ? pair
      : character === ';' || character === '|' || character === '&'
        ? character
        : undefined;
    if (!operator) continue;
    segments.push(command.slice(start, index).trim());
    operators.push(operator);
    index += operator.length - 1;
    start = index + 1;
  }

  if (singleQuoted || doubleQuoted || escaped) return undefined;
  segments.push(command.slice(start).trim());
  return { segments, operators };
}

function shellWords(command: string): readonly string[] | undefined {
  const words: string[] = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  const push = (): void => {
    if (current) words.push(current);
    current = '';
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && /\s/u.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  if (singleQuoted || doubleQuoted || escaped) return undefined;
  push();
  return words;
}

function canonicalNodePreflightSegment(segment: string, packageRoot: string, repoRoot: string): boolean {
  const words = shellWords(segment);
  if (!words) return false;
  const optionalSilent = (offset: number): boolean =>
    words.length === offset || (words.length === offset + 1 && words[offset] === '--silent');

  if (words[0] === 'npm' && words[1] === 'run' && words[2] === 'check:node-major' && optionalSilent(3)) {
    return packageRoot === repoRoot;
  }
  if (words[0] === 'npm' && words[1] === '--prefix' && words[3] === 'run' && words[4] === 'check:node-major' && optionalSilent(5)) {
    const prefix = words[2];
    return prefix !== undefined && resolve(packageRoot, prefix) === repoRoot;
  }
  if (words[0] === 'node' && words.length === 2) {
    const checkPath = words[1];
    return checkPath !== undefined && resolve(packageRoot, checkPath) === resolve(repoRoot, 'scripts/toolchain/check-node-major.mjs');
  }
  return false;
}

function npmScriptHasSafeNodePreflight(command: string, packageRoot: string, repoRoot: string): boolean {
  const chain = parseShellChain(command);
  if (!chain) return false;
  const targetIndexes = chain.segments
    .map((segment, index) => directTypeScriptLaunch(segment) ? index : -1)
    .filter((index) => index >= 0);
  if (targetIndexes.length === 0) return true;

  return targetIndexes.every((targetIndex) => {
    const target = chain.segments[targetIndex] ?? '';
    if (target.includes(TYPESCRIPT_CLI_LAUNCHER) || target.includes('Invoke-TypeScriptCli.ts')) return true;
    if (targetIndex === 0 || !canonicalNodePreflightSegment(chain.segments[0] ?? '', packageRoot, repoRoot)) return false;
    return chain.operators.slice(0, targetIndex).every((operator) => operator === '&&');
  });
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
    const source = readFileSync(absolute, 'utf8');
    const scan = workflowSetupNodeSteps(source, path);
    violations.push(...scan.violations);

    for (const step of scan.steps) {
      setupNodeCounts.set(path, (setupNodeCounts.get(path) ?? 0) + 1);
      const selectors = step.selectors;
      const valid = step.withMappings === 1
        && step.withIsMapping
        && selectors.length === 1
        && selectors[0]?.kind === 'node-version'
        && literalNodeMajor(selectors[0].value) === SUPPORTED_NODE_MAJOR;
      inventory.push({
        path,
        line: step.line,
        classification: valid ? 'native-node-22' : 'invalid',
        evidence: step.evidence,
      });

      if (step.withMappings === 0) {
        violations.push({
          path,
          line: step.line,
          rule: 'workflow-node-version',
          message: `actions/setup-node must declare one literal with.node-version: '${SUPPORTED_NODE_MAJOR}'.`,
        });
        continue;
      }
      if (step.withMappings !== 1) {
        violations.push({
          path,
          line: step.line,
          rule: 'workflow-node-version',
          message: 'actions/setup-node must have exactly one with mapping.',
        });
        continue;
      }
      if (!step.withIsMapping) {
        violations.push({
          path,
          line: step.line,
          rule: 'workflow-node-version',
          message: 'actions/setup-node with must be a YAML mapping containing one literal node-version.',
        });
        continue;
      }
      if (selectors.length === 0) {
        violations.push({
          path,
          line: step.line,
          rule: 'workflow-node-version',
          message: `actions/setup-node with mapping must declare one literal node-version: '${SUPPORTED_NODE_MAJOR}'.`,
        });
        continue;
      }
      if (selectors.length !== 1) {
        violations.push({
          path,
          line: selectors[0]?.line ?? step.line,
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
      if (path !== 'package.json' && !path.endsWith('/package.json')
        && (directTypeScriptLaunch(line) || nativeShebang(line) || line.includes('runNativeTypeScriptCli'))) {
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



  return { inventory, violations };
}

function scanPackageScripts(
  repoRoot: string,
  allFiles: readonly string[],
): { readonly inventory: readonly LaunchInventoryEntry[]; readonly violations: readonly RuntimePolicyViolation[] } {
  const inventory: LaunchInventoryEntry[] = [];
  const violations: RuntimePolicyViolation[] = [];

  for (const absolute of allFiles) {
    const path = normalizePath(relative(repoRoot, absolute));
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(readFileSync(absolute, 'utf8')) as PackageManifest;
    } catch {
      continue;
    }
    const packageRoot = dirname(absolute);
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      const testFrameworkOwned = /vitest/u.test(command) || command.includes('run-vitest-with-harness.mjs');
      if (testFrameworkOwned && !directTypeScriptLaunch(command)) {
        inventory.push({ path, line: 1, classification: 'test-framework-owned', evidence: `${name}: ${command}` });
        continue;
      }
      if (!directTypeScriptLaunch(command)) continue;
      const native = nativeTypeScriptLaunch(command);
      const preflighted = npmScriptHasSafeNodePreflight(command, packageRoot, repoRoot);
      inventory.push({
        path,
        line: 1,
        classification: native && preflighted ? 'native-node-22' : 'invalid',
        evidence: `${name}: ${command}`,
      });
      if (!native) {
        violations.push({
          path,
          line: 1,
          rule: 'direct-typescript-launch',
          message: `npm script ${name} must use native Node 22 type stripping or the canonical TypeScript launcher.`,
        });
      } else if (!preflighted) {
        violations.push({
          path,
          line: 1,
          rule: 'node-contract',
          message: `npm script ${name} must prove a successful canonical Node runtime preflight before every TypeScript target.`,
        });
      }
    }
  }
  return { inventory, violations };
}

function agentsRuntimeViolations(repoRoot: string): RuntimePolicyViolation[] {
  const path = resolve(repoRoot, AGENTS_PATH);
  if (!existsSync(path)) {
    return [{ path: AGENTS_PATH, line: 1, rule: 'agent-runtime-contract', message: 'worker rulebook is missing.' }];
  }
  const source = readFileSync(path, 'utf8');
  const required = [
    AGENTS_NODE_22_RULE,
    'scripts/toolchain/node-version.json',
    'package.json.engines.node',
    'Node 20',
    'actions/setup-node',
  ];
  const missing = required.filter((marker) => !source.includes(marker));
  return missing.length === 0
    ? []
    : [{
      path: AGENTS_PATH,
      line: 1,
      rule: 'agent-runtime-contract',
      message: `AGENTS.md must state the Node 22-only worker contract; missing markers: ${missing.join(', ')}.`,
    }];
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
  const packageScripts = scanPackageScripts(root, allFiles);
  const inventory = [...workflows.inventory, ...launches.inventory, ...packageScripts.inventory];
  violations.push(
    ...workflows.violations,
    ...launches.violations,
    ...packageScripts.violations,
    ...packageViolations(root, allFiles),
    ...agentsRuntimeViolations(root),
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
