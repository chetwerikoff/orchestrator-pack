import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type ProducerTaxonomy = 'a' | 'b' | 'c' | 'd';
export type ProducerOwner = 'wave-a' | 'wave-b' | 'wave-c' | 'wave-d' | 'wave-e1' | 'test-fixture';
export type GoldenStatus = 'live-golden' | 'historical' | 'none';
export type ProducerDisposition = 'migrated' | 'deferred' | 'excluded' | 'not-json';

export interface WaveBInventoryRow {
  readonly path: string;
  readonly sourceKind: 'powershell-json-producer' | 'named-non-json-surface';
  readonly taxonomy: ProducerTaxonomy;
  readonly ownerWave: ProducerOwner;
  readonly owningIssue: string;
  readonly disposition: ProducerDisposition;
  readonly reason: string;
  readonly goldenStatus: GoldenStatus;
  readonly parityTargets: readonly string[];
  readonly parityTests: readonly string[];
  readonly migratedModule?: string;
  readonly entrypointMode: 'wrapper' | 'unchanged' | 'removed';
}

export interface WaveBInventory {
  readonly schemaVersion: number;
  readonly issue: string;
  readonly analysisBase: string;
  readonly reachabilitySource: string;
  readonly discoveryMarkers: readonly string[];
  readonly taxonomy: Readonly<Record<ProducerTaxonomy, string>>;
  readonly rows: readonly WaveBInventoryRow[];
}

export interface ReconciliationInput {
  readonly inventory: WaveBInventory;
  readonly discoveredPowerShellProducers: readonly string[];
  readonly discoveredPortedModules: readonly string[];
  readonly fileSources: Readonly<Record<string, string>>;
  readonly existingPaths: ReadonlySet<string>;
}

const INVENTORY_RELATIVE_PATH = 'scripts/json-producers/wave-b-inventory.json';
const PRODUCER_SUPPORT_MODULES = new Set([
  'scripts/json-producers/cli.ts',
  'scripts/json-producers/golden-hygiene.ts',
  'scripts/json-producers/wave-b-reconciliation.ts',
]);

function normalizePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function asInventory(value: unknown): WaveBInventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Wave B inventory must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.issue !== '#831' || !Array.isArray(record.rows)) {
    throw new TypeError('Wave B inventory header is invalid');
  }
  return value as WaveBInventory;
}

export function loadWaveBInventory(repoRoot: string): WaveBInventory {
  return asInventory(JSON.parse(readFileSync(join(repoRoot, INVENTORY_RELATIVE_PATH), 'utf8')) as unknown);
}

export function discoverPowerShellJsonProducers(repoRoot: string, markers: readonly string[]): string[] {
  const scriptsRoot = join(repoRoot, 'scripts');
  return walkFiles(scriptsRoot)
    .filter((absolute) => absolute.endsWith('.ps1') && !absolute.endsWith('.Tests.ps1'))
    .filter((absolute) => {
      const source = readFileSync(absolute, 'utf8');
      return markers.some((marker) => source.includes(marker));
    })
    .map((absolute) => normalizePath(relative(repoRoot, absolute)))
    .sort();
}

export function discoverPortedProducerModules(repoRoot: string): string[] {
  const root = join(repoRoot, 'scripts', 'json-producers');
  return walkFiles(root)
    .filter((absolute) => absolute.endsWith('.ts') && !absolute.endsWith('.test.ts'))
    .map((absolute) => normalizePath(relative(repoRoot, absolute)))
    .filter((path) => !PRODUCER_SUPPORT_MODULES.has(path))
    .filter((path) => {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      return source.includes("from '#opk-kernel/json-artifact'")
        && (source.includes('serializeJsonArtifact') || source.includes('serializeGenericJsonArtifact'));
    })
    .sort();
}

export function readReconciliationSources(
  repoRoot: string,
  inventory: WaveBInventory,
  portedModules: readonly string[],
): Readonly<Record<string, string>> {
  const paths = new Set<string>(portedModules);
  for (const row of inventory.rows) paths.add(row.path);
  return Object.fromEntries(
    [...paths]
      .filter((path) => existsSync(join(repoRoot, path)))
      .map((path) => [path, readFileSync(join(repoRoot, path), 'utf8')]),
  );
}


export function findStaleRemovedEntrypointCalls(
  inventory: WaveBInventory,
  callerSources: Readonly<Record<string, string>>,
): string[] {
  const failures: string[] = [];
  const removed = inventory.rows.filter((row) => row.entrypointMode === 'removed');
  for (const row of removed) {
    const basename = row.path.split('/').pop() ?? row.path;
    for (const [callerPath, source] of Object.entries(callerSources)) {
      if (callerPath === row.path
        || callerPath === INVENTORY_RELATIVE_PATH
        || callerPath === 'scripts/reachability-purge.manifest.json'
        || callerPath === 'scripts/gate-runner/representative-gates.ts'
        || callerPath === 'scripts/gate-runner/goldens.test.ts'
        || callerPath.startsWith('scripts/gate-runner/goldens/')
        || callerPath.startsWith('scripts/gate-runner/census/')) continue;
      if (source.includes(row.path) || source.includes(basename)) {
        failures.push(`${callerPath}: stale invocation of removed entrypoint ${row.path}`);
      }
    }
  }
  return failures;
}

export function reconcileWaveBInventory(input: ReconciliationInput): string[] {
  const failures: string[] = [];
  const rowsByPath = new Map<string, WaveBInventoryRow>();
  const duplicatePaths = new Set<string>();

  for (const row of input.inventory.rows) {
    if (rowsByPath.has(row.path)) duplicatePaths.add(row.path);
    else rowsByPath.set(row.path, row);
    if (!row.path || !row.owningIssue || !row.reason) failures.push(`${row.path || '<empty>'}: incomplete ownership row`);
  }
  for (const path of duplicatePaths) failures.push(`${path}: claimed by more than one inventory row/wave`);

  for (const path of input.discoveredPowerShellProducers) {
    const row = rowsByPath.get(path);
    if (!row || row.sourceKind !== 'powershell-json-producer') {
      failures.push(`${path}: reachable JSON-producing PowerShell script is absent from inventory`);
    }
  }

  const referencedModules = new Set<string>();
  for (const row of input.inventory.rows.filter((candidate) => candidate.ownerWave === 'wave-b')) {
    if (row.disposition !== 'migrated') failures.push(`${row.path}: Wave B row is not marked migrated`);
    if (row.goldenStatus !== 'live-golden') failures.push(`${row.path}: Wave B row lacks a live parity target`);
    if (row.parityTargets.length === 0) failures.push(`${row.path}: Wave B row has no golden path`);
    if (row.parityTests.length === 0) failures.push(`${row.path}: Wave B row has no parity test`);
    if (!row.migratedModule) failures.push(`${row.path}: Wave B row has no migrated TypeScript module`);
    else referencedModules.add(row.migratedModule);
    for (const path of [...row.parityTargets, ...row.parityTests]) {
      if (!input.existingPaths.has(path)) failures.push(`${row.path}: declared evidence path is missing: ${path}`);
    }
    if (!input.existingPaths.has(row.path)) failures.push(`${row.path}: compatibility entrypoint is missing`);
    const wrapperSource = input.fileSources[row.path] ?? '';
    if (row.entrypointMode === 'wrapper') {
      const moduleSuffix = row.migratedModule?.split('/').slice(-2).join('/') ?? '';
      if (!wrapperSource.includes('node') || !moduleSuffix || !wrapperSource.includes(moduleSuffix)) {
        failures.push(`${row.path}: wrapper does not invoke its inventoried TypeScript module`);
      }
      if (wrapperSource.includes('ConvertTo-Json')) failures.push(`${row.path}: compatibility wrapper still serializes JSON`);
    }
  }

  for (const modulePath of input.discoveredPortedModules) {
    if (!referencedModules.has(modulePath)) failures.push(`${modulePath}: ported producer is absent from inventory`);
  }
  for (const modulePath of referencedModules) {
    if (!input.discoveredPortedModules.includes(modulePath)) failures.push(`${modulePath}: inventoried migrated module is not discoverable as a kernel JSON producer`);
    if (!input.existingPaths.has(modulePath)) failures.push(`${modulePath}: inventoried migrated module is missing`);
    const source = input.fileSources[modulePath] ?? '';
    if (source.includes('JSON.stringify(') || source.includes('ConvertTo-Json')) {
      failures.push(`${modulePath}: hand-rolled JSON serialization bypasses the kernel`);
    }
    if (!source.includes("from '#opk-kernel/json-artifact'")) {
      failures.push(`${modulePath}: migrated producer does not import the JSON artifact kernel`);
    }
  }

  for (const row of input.inventory.rows.filter((candidate) => candidate.sourceKind === 'named-non-json-surface')) {
    const source = input.fileSources[row.path] ?? '';
    if (input.inventory.discoveryMarkers.some((marker) => source.includes(marker))) {
      failures.push(`${row.path}: inventory says non-JSON but source contains a JSON producer marker`);
    }
    if (row.ownerWave === 'wave-b') failures.push(`${row.path}: non-JSON surface cannot be owned by Wave B`);
  }

  return failures;
}


function collectAllowedRootSources(repoRoot: string): Readonly<Record<string, string>> {
  const absolutePaths = [
    ...walkFiles(join(repoRoot, 'scripts')),
    ...walkFiles(join(repoRoot, 'tests')),
    ...walkFiles(join(repoRoot, '.github', 'workflows')),
    ...['package.json', 'package-lock.json']
      .map((path) => join(repoRoot, path))
      .filter((path) => existsSync(path)),
  ];
  return Object.fromEntries(absolutePaths.map((absolute) => [
    normalizePath(relative(repoRoot, absolute)),
    readFileSync(absolute, 'utf8'),
  ]));
}

export function checkWaveBReconciliation(repoRoot = resolve('.')): string[] {
  const inventory = loadWaveBInventory(repoRoot);
  const discoveredCurrent = discoverPowerShellJsonProducers(repoRoot, inventory.discoveryMarkers);
  const migratedLegacyPaths = inventory.rows
    .filter((row) => row.ownerWave === 'wave-b' && row.sourceKind === 'powershell-json-producer')
    .map((row) => row.path);
  const discoveredPowerShellProducers = [...new Set([...discoveredCurrent, ...migratedLegacyPaths])].sort();
  const discoveredPortedModules = discoverPortedProducerModules(repoRoot);
  const fileSources = readReconciliationSources(repoRoot, inventory, discoveredPortedModules);
  const existingPaths = new Set(
    walkFiles(repoRoot).map((absolute) => normalizePath(relative(repoRoot, absolute))),
  );
  return [
    ...reconcileWaveBInventory({
      inventory,
      discoveredPowerShellProducers,
      discoveredPortedModules,
      fileSources,
      existingPaths,
    }),
    ...findStaleRemovedEntrypointCalls(inventory, collectAllowedRootSources(repoRoot)),
  ];
}
