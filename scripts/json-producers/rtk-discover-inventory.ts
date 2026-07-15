import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';
import {
  PRETTY_JSON_WITH_NEWLINE,
  serializeJsonArtifact,
  validateJsonValue,
  type JsonArtifactContract,
  type JsonValue,
} from '#opk-kernel/json-artifact';
import {
  argumentValue,
  describeError,
  integerArgument,
  isDirectExecution,
  parseArguments,
} from './cli.js';

export type RtkRiskTier = 'low' | 'medium' | 'high' | 'unknown';

export interface RtkInventoryRow {
  readonly CommandShape: string;
  readonly OccurrenceCount: number;
  readonly EstimatedMissedTokens: number | null;
  readonly PassthroughMatch: boolean;
  readonly PassthroughPattern: string;
  readonly RiskTier: RtkRiskTier;
  readonly SensitivityExactnessOverride: boolean;
  readonly RecommendedAction: string;
  readonly FieldPreservationTestRequired: boolean;
  readonly DiscoverBucket: 'supported' | 'unsupported';
}

export interface RtkInventory {
  readonly SessionsScanned: number;
  readonly TotalCommands: number;
  readonly SinceDays: number;
  readonly Rows: readonly RtkInventoryRow[];
}

export interface RtkKillGateAssessment {
  readonly MaterialityPercent: number;
  readonly LowRiskQuantifiedMissedTokens: number;
  readonly HighRiskAoInvocationCount: number;
  readonly HighRiskAoTokensPerInvocation: number;
  readonly HighRiskAoEstimatedMissedTokens: number;
  readonly HighRiskSharePercent: number;
  readonly Decision: 'go' | 'no-go';
}

export interface RtkInventoryArtifact {
  readonly generatedAt: string;
  readonly discover: JsonValue;
  readonly inventoryRows: readonly RtkInventoryRow[];
  readonly killGate: RtkKillGateAssessment;
}

const LOW_PREFIXES = ['grep', 'find', 'cat ', 'cat\t', 'ls ', 'ls\t', 'wc ', 'head ', 'tail ', 'tree '];
const MEDIUM_PREFIXES = ['gh pr', 'gh issue', 'git branch', 'git log'];
const HIGH_PREFIXES = [
  'ao status', 'ao-review', 'ao events', 'ao report', 'ao send', 'ao spawn',
  'npx ao-declare', 'ao-declare', 'git diff', 'gh pr checks',
];
const SENSITIVITY_TARGETS = [
  '.env', 'credentials', 'secret', 'token', 'private-key', 'id_rsa',
  'declarations/', '.ao/declarations', 'agent-orchestrator.yaml',
];

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function finiteInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function hasSensitivityOverride(commandShape: string): boolean {
  const lower = commandShape.toLowerCase();
  return SENSITIVITY_TARGETS.some((needle) => lower.includes(needle));
}

export function classifyRtkRisk(commandShape: string): RtkRiskTier {
  if (hasSensitivityOverride(commandShape)) return 'high';
  const normalized = commandShape.trim().toLowerCase();
  if (HIGH_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized === prefix.trim())) return 'high';
  if (/^ao(\s|$)/.test(normalized)) return 'high';
  if (MEDIUM_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'medium';
  if (LOW_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'low';
  return 'unknown';
}

function passthroughMatch(commandShape: string, patterns: readonly string[]): { matched: boolean; pattern: string } {
  const pattern = patterns.find((candidate) => commandShape.includes(candidate));
  return { matched: pattern !== undefined, pattern: pattern ?? '' };
}

function recommendedAction(risk: RtkRiskTier, matched: boolean, sensitive: boolean): string {
  if (sensitive) return 'permanently-raw (sensitivity/exactness override)';
  if (risk === 'low') {
    return matched
      ? 'guidance: prefer dedicated file tools; RTK may already compact when not passthrough-matched'
      : 'low-risk capture candidate (guidance + optional passthrough review when not in §R.3 family)';
  }
  if (risk === 'medium') return 'inventory + guidance only (no passthrough change without §6-class gate)';
  if (risk === 'high') return 'permanently-raw or §6-gated JSON inspection only (never blanket ao removal)';
  return 'classify manually; default guidance-only until tier known';
}

function fieldPreservationRequired(risk: RtkRiskTier, matched: boolean, sensitive: boolean): boolean {
  return !sensitive && matched && (risk === 'high' || risk === 'medium');
}

function makeRow(
  commandShape: string,
  occurrenceCount: number,
  estimatedMissedTokens: number | null,
  bucket: RtkInventoryRow['DiscoverBucket'],
  patterns: readonly string[],
  classificationShape = commandShape,
): RtkInventoryRow {
  const risk = classifyRtkRisk(classificationShape);
  const sensitive = hasSensitivityOverride(classificationShape);
  const match = passthroughMatch(classificationShape, patterns);
  return {
    CommandShape: commandShape,
    OccurrenceCount: occurrenceCount,
    EstimatedMissedTokens: estimatedMissedTokens,
    PassthroughMatch: match.matched,
    PassthroughPattern: match.pattern,
    RiskTier: risk,
    SensitivityExactnessOverride: sensitive,
    RecommendedAction: recommendedAction(risk, match.matched, sensitive),
    FieldPreservationTestRequired: fieldPreservationRequired(risk, match.matched, sensitive),
    DiscoverBucket: bucket,
  };
}

export function normalizeRtkDiscover(
  discover: unknown,
  patterns: readonly string[],
): RtkInventory {
  const doc = record(discover);
  const normalized: RtkInventoryRow[] = [];
  for (const entry of rows(doc.supported)) {
    const shape = String(entry.command ?? '');
    normalized.push(makeRow(
      shape,
      finiteInteger(entry.count),
      finiteInteger(entry.estimated_savings_tokens),
      'supported',
      patterns,
    ));
  }
  for (const entry of rows(doc.unsupported)) {
    const example = String(entry.example ?? '');
    const shape = String(entry.base_command ?? '') || example;
    normalized.push(makeRow(shape, finiteInteger(entry.count), null, 'unsupported', patterns, example || shape));
  }
  return {
    SessionsScanned: finiteInteger(doc.sessions_scanned),
    TotalCommands: finiteInteger(doc.total_commands),
    SinceDays: finiteInteger(doc.since_days),
    Rows: normalized,
  };
}

export function assessRtkKillGate(
  inventoryRows: readonly RtkInventoryRow[],
  materialityPercent = 15,
  highRiskAoTokensPerInvocation = 250,
): RtkKillGateAssessment {
  let lowRiskTokens = 0;
  let highAoCount = 0;
  for (const row of inventoryRows) {
    if (row.RiskTier === 'low' && row.EstimatedMissedTokens !== null) lowRiskTokens += row.EstimatedMissedTokens;
    if (row.RiskTier === 'high' && /^ao(\s|$| review| events| status| spawn| report| send| session| list| worker)/.test(row.CommandShape)) {
      highAoCount += row.OccurrenceCount;
    }
  }
  const highAoTokens = highAoCount * highRiskAoTokensPerInvocation;
  const denominator = lowRiskTokens + highAoTokens;
  const share = denominator > 0 ? Math.round((1000 * highAoTokens) / denominator) / 10 : 0;
  return {
    MaterialityPercent: materialityPercent,
    LowRiskQuantifiedMissedTokens: lowRiskTokens,
    HighRiskAoInvocationCount: highAoCount,
    HighRiskAoTokensPerInvocation: highRiskAoTokensPerInvocation,
    HighRiskAoEstimatedMissedTokens: highAoTokens,
    HighRiskSharePercent: share,
    Decision: share >= materialityPercent ? 'go' : 'no-go',
  };
}

function loadPatterns(path: string): string[] {
  const parsed = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!Array.isArray(parsed.patterns)) throw new Error(`Manifest missing patterns array: ${path}`);
  const patterns = parsed.patterns.map((value) => String(value)).filter((value) => value.trim());
  if (patterns.length === 0) throw new Error(`Manifest missing patterns array: ${path}`);
  return patterns;
}

export function loadRtkPassthroughPatterns(root = repoRoot()): string[] {
  return [
    ...loadPatterns(join(root, 'scripts/rtk-passthrough-pack.manifest.json')),
    ...loadPatterns(join(root, 'scripts/rtk-passthrough-upstream-defaults.manifest.json')),
  ];
}

export function dotNetRoundTripTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/(\.\d{3})Z$/, '$10000Z');
}

function validateArtifact(value: unknown): RtkInventoryArtifact {
  const artifact = record(value);
  return {
    generatedAt: String(artifact.generatedAt ?? ''),
    discover: validateJsonValue(artifact.discover),
    inventoryRows: Array.isArray(artifact.inventoryRows) ? artifact.inventoryRows as unknown as RtkInventoryRow[] : [],
    killGate: artifact.killGate as RtkKillGateAssessment,
  };
}

export const RTK_INVENTORY_ARTIFACT_CONTRACT: JsonArtifactContract<RtkInventoryArtifact> = {
  id: 'rtk-discover-inventory/v1',
  validate: (value) => validateArtifact(value),
  format: PRETTY_JSON_WITH_NEWLINE,
};

export function buildRtkInventoryArtifact(
  discover: JsonValue,
  inventory: RtkInventory,
  killGate: RtkKillGateAssessment,
  nowMs: number,
): RtkInventoryArtifact {
  return {
    generatedAt: dotNetRoundTripTimestamp(nowMs),
    discover,
    inventoryRows: inventory.Rows,
    killGate,
  };
}

export function renderRtkInventoryMarkdown(
  inventory: RtkInventory,
  killGate: RtkKillGateAssessment,
  nowMs: number,
): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const lines = [
    `# RTK missed-savings inventory (generated ${date})`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Sessions scanned | ${inventory.SessionsScanned} |`,
    `| Total commands | ${inventory.TotalCommands} |`,
    `| Since (days) | ${inventory.SinceDays} |`,
    '| Source/caller attribution | **not available** (rtk discover has no caller dimension) |',
    '| Optimisation target | **net saved tokens on low-risk shapes** (adoption % is a non-goal) |',
    '',
    '## Kill-gate assessment (high-risk `ao` / inspection families)',
    '',
    '| Input | Value |',
    '|-------|-------|',
    `| Materiality bar | ≥${killGate.MaterialityPercent}% of (low-risk quantified missed tokens + conservative high-risk \`ao\` estimate) |`,
    `| Low-risk quantified missed tokens | ${killGate.LowRiskQuantifiedMissedTokens} |`,
    `| High-risk \`ao\` invocations | ${killGate.HighRiskAoInvocationCount} |`,
    `| Conservative \`ao\` tokens saved / invocation | ${killGate.HighRiskAoTokensPerInvocation} |`,
    `| High-risk \`ao\` estimated missed tokens | ${killGate.HighRiskAoEstimatedMissedTokens} |`,
    `| High-risk share | ${killGate.HighRiskSharePercent}% |`,
    `| Decision | **${killGate.Decision}** |`,
    '',
    '## Inventory rows',
    '',
    '| Command shape | Count | Est. missed tokens | Passthrough | Risk | Sensitivity override | Recommended action | Field-preservation test? |',
    '|---------------|------:|-------------------:|:------------|:-----|:---------------------|:-------------------|:-------------------------|',
  ];
  const sorted = [...inventory.Rows].sort((left, right) => right.OccurrenceCount - left.OccurrenceCount);
  for (const row of sorted) {
    const tokens = row.EstimatedMissedTokens === null ? '—' : String(row.EstimatedMissedTokens);
    const passthrough = row.PassthroughMatch ? `yes (${row.PassthroughPattern})` : 'no';
    const shape = row.CommandShape.replaceAll('|', '\\|');
    lines.push(`| ${shape} | ${row.OccurrenceCount} | ${tokens} | ${passthrough} | ${row.RiskTier} | ${row.SensitivityExactnessOverride ? 'yes' : 'no'} | ${row.RecommendedAction} | ${row.FieldPreservationTestRequired ? 'yes' : 'no'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

async function discoverPayload(args: ReturnType<typeof parseArguments>, sinceDays: number, limit: number): Promise<JsonValue> {
  const fixture = argumentValue(args, 'discover-fixture');
  if (fixture) return validateJsonValue(JSON.parse(readFileSync(fixture, 'utf8')) as unknown);
  const commandArgs = ['discover', '--format', 'json', '--since', String(sinceDays), '--limit', String(limit)];
  if (args.flags.has('all-projects')) commandArgs.push('--all');
  const result = await runProcess({
    command: 'rtk',
    args: commandArgs,
    inheritParentEnv: true,
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(`rtk discover failed: exit=${result.exitCode ?? result.outcome}: ${result.stderr || result.error || result.stdout}`);
  }
  return validateJsonValue(JSON.parse(result.stdout) as unknown);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const sinceDays = integerArgument(args, 'since-days', 30);
  const limit = integerArgument(args, 'limit', 50);
  const nowMs = integerArgument(args, 'now-ms', Date.now());
  const discover = await discoverPayload(args, sinceDays, limit);
  const inventory = normalizeRtkDiscover(discover, loadRtkPassthroughPatterns());
  const killGate = assessRtkKillGate(inventory.Rows);
  process.stdout.write(renderRtkInventoryMarkdown(inventory, killGate, nowMs));
  const outputPath = argumentValue(args, 'output-json');
  if (outputPath) {
    const artifact = buildRtkInventoryArtifact(discover, inventory, killGate, nowMs);
    writeAtomic(outputPath, serializeJsonArtifact(artifact, RTK_INVENTORY_ARTIFACT_CONTRACT));
    process.stdout.write(`\nWrote JSON artifact: ${outputPath}\n`);
  }
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  });
}
