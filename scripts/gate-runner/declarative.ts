import { failGate, passGate, skipGate, type EvidenceObservation, type GateResult } from './contracts.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export type DeclarativeRuleKind = 'grep-inventory' | 'line-byte-budget' | 'file-presence' | 'static-source';

export interface GrepInventoryRule {
  readonly kind: 'grep-inventory';
  readonly patterns: readonly RegExp[];
  readonly excludePrefixes?: readonly string[];
  readonly excludePaths?: readonly string[];
  readonly failureSuffix: string;
}

export interface LineByteBudgetRule {
  readonly kind: 'line-byte-budget';
  readonly path: string;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface FilePresenceRule {
  readonly kind: 'file-presence';
  readonly paths: readonly string[];
}

export interface SourceAssertion {
  readonly path: string;
  readonly contains?: readonly string[];
  readonly absent?: readonly string[];
}

export interface StaticSourceRule {
  readonly kind: 'static-source';
  readonly assertions: readonly SourceAssertion[];
}

export type DeclarativeRule = GrepInventoryRule | LineByteBudgetRule | FilePresenceRule | StaticSourceRule;

export interface DeclarativeGateDefinition {
  readonly gateId: string;
  readonly legacyScript: string;
  readonly summary: string;
  readonly rules: readonly DeclarativeRule[];
  readonly passStdout: string;
  readonly failHeading: string;
}

interface RuleEvaluation {
  readonly failures: readonly string[];
  readonly unavailable: readonly string[];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function evaluateGrep(rule: GrepInventoryRule, snapshot: SourceSnapshot): RuleEvaluation {
  const failures: string[] = [];
  const unavailable: string[] = [];
  const excluded = new Set((rule.excludePaths ?? []).map(normalizePath));
  for (const path of snapshot.paths) {
    const normalized = normalizePath(path);
    if (excluded.has(normalized)) continue;
    if ((rule.excludePrefixes ?? []).some((prefix) => normalized.startsWith(prefix))) continue;
    const unreadable = snapshot.unreadable.get(normalized);
    if (unreadable !== undefined) {
      unavailable.push(`${normalized}: ${unreadable}`);
      continue;
    }
    const text = snapshot.files.get(normalized);
    if (text === undefined) {
      unavailable.push(`${normalized}: snapshot content missing`);
      continue;
    }
    if (rule.patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })) failures.push(`${normalized} ${rule.failureSuffix}`);
  }
  return { failures, unavailable };
}

function evaluateBudget(rule: LineByteBudgetRule, snapshot: SourceSnapshot): RuleEvaluation {
  const path = normalizePath(rule.path);
  const text = snapshot.files.get(path);
  if (text === undefined) {
    return snapshot.paths.includes(path)
      ? { failures: [], unavailable: [`${path}: ${snapshot.unreadable.get(path) ?? 'content unavailable'}`] }
      : { failures: [`missing ${path}`], unavailable: [] };
  }
  const lineCount = text.split('\n').length;
  const byteCount = Buffer.byteLength(text, 'utf8');
  const failures: string[] = [];
  if (lineCount > rule.maxLines) failures.push(`${path} has ${lineCount} lines (ceiling ${rule.maxLines})`);
  if (byteCount > rule.maxBytes) failures.push(`${path} has ${byteCount} bytes (ceiling ${rule.maxBytes})`);
  return { failures, unavailable: [] };
}

function evaluatePresence(rule: FilePresenceRule, snapshot: SourceSnapshot): RuleEvaluation {
  const failures = rule.paths
    .map(normalizePath)
    .filter((path) => !snapshot.paths.includes(path))
    .map((path) => `missing required file: ${path}`);
  const unavailable = rule.paths
    .map(normalizePath)
    .filter((path) => snapshot.unreadable.has(path))
    .map((path) => `${path}: ${snapshot.unreadable.get(path)}`);
  return { failures, unavailable };
}

function evaluateStatic(rule: StaticSourceRule, snapshot: SourceSnapshot): RuleEvaluation {
  const failures: string[] = [];
  const unavailable: string[] = [];
  for (const assertion of rule.assertions) {
    const path = normalizePath(assertion.path);
    const text = snapshot.files.get(path);
    if (text === undefined) {
      if (snapshot.paths.includes(path)) unavailable.push(`${path}: ${snapshot.unreadable.get(path) ?? 'content unavailable'}`);
      else failures.push(`missing required file: ${path}`);
      continue;
    }
    for (const marker of assertion.contains ?? []) {
      if (!text.includes(marker)) failures.push(`${path} missing required content: ${marker}`);
    }
    for (const marker of assertion.absent ?? []) {
      if (text.includes(marker)) failures.push(`${path} contains forbidden content: ${marker}`);
    }
  }
  return { failures, unavailable };
}

export function evaluateRule(rule: DeclarativeRule, snapshot: SourceSnapshot): RuleEvaluation {
  switch (rule.kind) {
    case 'grep-inventory': return evaluateGrep(rule, snapshot);
    case 'line-byte-budget': return evaluateBudget(rule, snapshot);
    case 'file-presence': return evaluatePresence(rule, snapshot);
    case 'static-source': return evaluateStatic(rule, snapshot);
  }
}

export function formatLegacyFailure(heading: string, failures: readonly string[]): string {
  return `${heading}\n${failures.map((failure) => ` - ${failure}`).join('\n')}\n`;
}

export function evaluateDeclarativeGate(
  definition: DeclarativeGateDefinition,
  snapshot: SourceSnapshot,
): GateResult {
  const evidence: EvidenceObservation[] = [{
    class: 'static-source',
    state: 'present',
    source: snapshot.root,
  }];
  const failures: string[] = [];
  const unavailable: string[] = [];
  for (const rule of definition.rules) {
    const evaluated = evaluateRule(rule, snapshot);
    failures.push(...evaluated.failures);
    unavailable.push(...evaluated.unavailable);
  }
  if (unavailable.length > 0) {
    return skipGate(
      definition.gateId,
      `${definition.summary} Source evidence is unreachable.`,
      [{ ...evidence[0]!, state: 'unreachable', detail: unavailable.join('; ') }],
      unavailable,
    );
  }
  if (failures.length > 0) {
    return failGate(
      definition.gateId,
      definition.summary,
      evidence,
      failures,
      formatLegacyFailure(definition.failHeading, failures),
    );
  }
  return passGate(
    definition.gateId,
    definition.summary,
    ['static-source'],
    evidence,
    { legacyStdout: definition.passStdout },
  );
}
