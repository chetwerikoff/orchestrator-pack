import { failGate, passGate, skipGate, type EvidenceObservation, type GateResult } from './contracts.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export type DeclarativeRuleKind = 'grep-inventory' | 'line-byte-budget' | 'file-presence' | 'file-absence' | 'static-source' | 'section-anchor';

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

export interface FileAbsenceRule {
  readonly kind: 'file-absence';
  readonly paths: readonly string[];
}

export interface ExactOccurrenceAssertion {
  readonly marker: string;
  readonly count: number;
}

export interface SourceAssertion {
  readonly path: string;
  readonly contains?: readonly string[];
  readonly absent?: readonly string[];
  readonly absentFailurePrefix?: string;
  readonly exactOccurrences?: readonly ExactOccurrenceAssertion[];
}

export interface StaticSourceRule {
  readonly kind: 'static-source';
  readonly assertions: readonly SourceAssertion[];
}

export interface SectionAnchorRule {
  readonly kind: 'section-anchor';
  readonly roots: readonly string[];
}

export type DeclarativeRule = GrepInventoryRule | LineByteBudgetRule | FilePresenceRule | FileAbsenceRule | StaticSourceRule | SectionAnchorRule;

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

function evaluateAbsence(rule: FileAbsenceRule, snapshot: SourceSnapshot): RuleEvaluation {
  const failures = rule.paths
    .map(normalizePath)
    .filter((path) => snapshot.paths.includes(path))
    .map((path) => `retired file must be absent: ${path}`);
  return { failures, unavailable: [] };
}

function countLiteralOccurrences(text: string, marker: string): number {
  if (marker.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = text.indexOf(marker, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + marker.length;
  }
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
      if (text.includes(marker)) {
        failures.push(assertion.absentFailurePrefix
          ? `${assertion.absentFailurePrefix}: ${marker}`
          : `${path} contains forbidden content: ${marker}`);
      }
    }
    for (const occurrence of assertion.exactOccurrences ?? []) {
      const actual = countLiteralOccurrences(text, occurrence.marker);
      if (actual !== occurrence.count) {
        failures.push(
          `${path} must contain exactly ${occurrence.count} occurrence(s) of ${occurrence.marker}; found ${actual}`,
        );
      }
    }
  }
  return { failures, unavailable };
}

function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/gu, '-');
}

function headingSlugs(text: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(\S.*)$/u.exec(line);
    if (match) slugs.add(githubHeadingSlug(match[2]!));
  }
  return slugs;
}

function resolveLinkTarget(fromPath: string, rawTarget: string): { path: string; fragment: string } | undefined {
  const trimmed = rawTarget.trim().replace(/^<|>$/gu, '');
  if (/^(?:https?:|mailto:|javascript:)/iu.test(trimmed)) return undefined;
  const hash = trimmed.indexOf('#');
  const relative = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const fragment = hash >= 0 ? trimmed.slice(hash + 1) : '';
  if (!fragment) return undefined;
  const path = relative.length === 0
    ? fromPath
    : normalizePath(`${fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : ''}${relative}`);
  if (path.startsWith('../') || path.includes('/../')) {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    return { path: parts.join('/'), fragment };
  }
  return { path, fragment };
}

function evaluateSectionAnchor(rule: SectionAnchorRule, snapshot: SourceSnapshot): RuleEvaluation {
  const failures: string[] = [];
  const unavailable: string[] = [];
  const roots = rule.roots.map(normalizePath);
  const sources = snapshot.paths.filter((path) => {
    const normalized = normalizePath(path);
    return roots.some((root) => normalized === root || (root.endsWith('/') ? normalized.startsWith(root) : normalized.startsWith(`${root}/`)));
  });
  for (const sourcePath of sources) {
    const text = snapshot.files.get(normalizePath(sourcePath));
    if (text === undefined) {
      unavailable.push(`${sourcePath}: ${snapshot.unreadable.get(normalizePath(sourcePath)) ?? 'content unavailable'}`);
      continue;
    }
    const markdownLinks = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)];
    for (const match of markdownLinks) {
      const resolved = resolveLinkTarget(normalizePath(sourcePath), match[1]!);
      if (resolved === undefined) continue;
      if (!/\.(?:md|mdc)$/iu.test(resolved.path)) continue;
      const targetText = snapshot.files.get(resolved.path);
      if (targetText === undefined) {
        if (snapshot.paths.includes(resolved.path) || snapshot.unreadable.has(resolved.path)) {
          unavailable.push(`${resolved.path}: ${snapshot.unreadable.get(resolved.path) ?? 'content unavailable'}`);
        } else {
          failures.push(`${sourcePath} unresolved section link: ${match[1]} (missing ${resolved.path})`);
        }
        continue;
      }
      const slugs = headingSlugs(targetText);
      const expected = decodeURIComponent(resolved.fragment).toLowerCase();
      if (![...slugs].some((slug) => slug === expected || slug === githubHeadingSlug(decodeURIComponent(resolved.fragment)))) {
        failures.push(`${sourcePath} unresolved section link: ${match[1]}`);
      }
    }
  }
  return { failures, unavailable };
}

export function evaluateRule(rule: DeclarativeRule, snapshot: SourceSnapshot): RuleEvaluation {
  switch (rule.kind) {
    case 'grep-inventory': return evaluateGrep(rule, snapshot);
    case 'line-byte-budget': return evaluateBudget(rule, snapshot);
    case 'file-presence': return evaluatePresence(rule, snapshot);
    case 'file-absence': return evaluateAbsence(rule, snapshot);
    case 'static-source': return evaluateStatic(rule, snapshot);
    case 'section-anchor': return evaluateSectionAnchor(rule, snapshot);
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
