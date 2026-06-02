import type { StructuredFinding } from './types.js';

export const NO_FINDINGS_TOKEN = 'NO_FINDINGS';

const LEGACY_CLEAN_RE =
  /no concrete bugs were identified|no issues found|looks good to me|\blgtm\b/i;

const REQUIRED_FIELDS = ['type', 'code', 'severity', 'path', 'summary', 'source'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripMarkdownJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function tryParseJson(value: string): unknown {
  const candidates = [stripMarkdownJsonFence(value)];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  return null;
}

function normalizePathField(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function normalizeFinding(value: unknown, index: number): StructuredFinding | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const field of REQUIRED_FIELDS) {
    if (field === 'path') {
      continue;
    }
    if (typeof record[field] !== 'string' || !record[field]!.toString().trim()) {
      return null;
    }
  }

  if (!('path' in record)) {
    return null;
  }

  const summary = String(record.summary).trim();
  const type = String(record.type).trim();
  const code = String(record.code).trim();
  const severity = String(record.severity).trim();
  const source = String(record.source).trim();

  if (!summary || !type || !code || !severity || !source) {
    return null;
  }

  return {
    type,
    code,
    severity,
    path: normalizePathField(record.path),
    summary,
    details: typeof record.details === 'string' ? record.details : undefined,
    suggested_fix:
      typeof record.suggested_fix === 'string' ? record.suggested_fix : undefined,
    source,
  };
}

export type ParseCodexOutputResult =
  | { kind: 'clean' }
  | { kind: 'findings'; findings: StructuredFinding[] }
  | { kind: 'error'; message: string };

/** Unwrap Claude CLI JSON, fences, and leading prose before findings JSON. */
export function normalizeReviewerStdout(rawOutput: string): string {
  let value = rawOutput.trim();
  if (!value) {
    return value;
  }

  const wrapper = tryParseJson(value);
  const wrapperRecord = asRecord(wrapper);
  if (wrapperRecord && typeof wrapperRecord.result === 'string') {
    value = wrapperRecord.result.trim();
  }

  value = stripMarkdownJsonFence(value);

  const findingsStart = value.indexOf('{"findings"');
  if (findingsStart > 0) {
    value = value.slice(findingsStart);
    const lastBrace = value.lastIndexOf('}');
    if (lastBrace >= 0) {
      value = value.slice(0, lastBrace + 1);
    }
  }

  const noFindingsIdx = value.indexOf(NO_FINDINGS_TOKEN);
  if (noFindingsIdx >= 0) {
    const tail = value.slice(noFindingsIdx).trim();
    if (tail === NO_FINDINGS_TOKEN || tail.startsWith(`${NO_FINDINGS_TOKEN}\n`)) {
      return NO_FINDINGS_TOKEN;
    }
  }

  return value.trim();
}

/**
 * Strict pack JSON for split-channel recovery (#135): entire trimmed channel must
 * be a pack-format `{"findings":[...]}` object with a non-empty findings array.
 * Bare JSON arrays and legacy stdout normalization are not accepted here.
 */
export function extractStrictPackFindingsArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === NO_FINDINGS_TOKEN) {
    return null;
  }

  let jsonText = trimmed;
  const entireFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (entireFence?.[1]) {
    jsonText = entireFence[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const record = asRecord(parsed);
    const rawFindings = Array.isArray(record?.findings)
      ? (record.findings as unknown[])
      : null;
    return rawFindings && rawFindings.length > 0 ? rawFindings : null;
  } catch {
    return null;
  }
}

export function normalizeStructuredPackFindings(
  rawFindings: unknown[],
): StructuredFinding[] | null {
  const findings = rawFindings
    .map((entry, index) => normalizeFinding(entry, index))
    .filter((entry): entry is StructuredFinding => entry !== null);

  return findings.length === rawFindings.length ? findings : null;
}

export function parseCodexOutput(rawOutput: string): ParseCodexOutputResult {
  const trimmed = normalizeReviewerStdout(rawOutput);

  if (trimmed === NO_FINDINGS_TOKEN) {
    return { kind: 'clean' };
  }

  if (!trimmed) {
    return {
      kind: 'error',
      message: 'reviewer produced empty output — refusing to mark run as clean',
    };
  }

  if (LEGACY_CLEAN_RE.test(trimmed)) {
    return {
      kind: 'error',
      message:
        'reviewer returned legacy clean-review prose instead of NO_FINDINGS — refusing to mark run as clean',
    };
  }

  const parsed = tryParseJson(trimmed);
  const record = asRecord(parsed);
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.findings)
      ? (record!.findings as unknown[])
      : null;

  if (rawFindings) {
    const findings = rawFindings
      .map((entry, index) => normalizeFinding(entry, index))
      .filter((entry): entry is StructuredFinding => entry !== null);

    if (findings.length !== rawFindings.length) {
      return {
        kind: 'error',
        message: 'reviewer JSON findings missing mandatory structured fields',
      };
    }

    return { kind: 'findings', findings };
  }

  return {
    kind: 'error',
    message:
      'reviewer output is not NO_FINDINGS or structured JSON findings — refusing to accept free-form prose',
  };
}
