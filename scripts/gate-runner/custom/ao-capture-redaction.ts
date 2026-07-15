import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  JsonContractError,
  expectRecord,
  parseJsonDocument,
} from '#opk-kernel/json-contract';
import {
  failGate,
  passGate,
  skipGate,
  type EvidenceObservation,
  type GateResult,
} from '../contracts.ts';

export const CAPTURE_DIRECTORY = 'tests/external-output-references/captures/ao-0-10-cli';

export const FORBIDDEN_CAPTURE_PATTERNS = [
  /\/home\/che\//u,
  /\/home\/[^/]+\/\.ao\//u,
  /Bearer\s+/u,
  /ghp_/u,
  /gho_/u,
  /ghu_/u,
  /ghs_/u,
  /ghr_/u,
  /github_pat_/u,
  /sk-/u,
  /AKIA[0-9A-Z]{16}/u,
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:]+:[^@]+@/u,
] as const;

export interface CaptureReader {
  list(relativeDirectory: string): readonly string[] | undefined;
  read(relativePath: string): string | undefined;
}

export function fileCaptureReader(repoRoot: string): CaptureReader {
  return {
    list(relativeDirectory: string): readonly string[] | undefined {
      try {
        return readdirSync(resolve(repoRoot, relativeDirectory), { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.raw.json'))
          .map((entry) => `${relativeDirectory}/${entry.name}`)
          .sort();
      } catch {
        return undefined;
      }
    },
    read(relativePath: string): string | undefined {
      try {
        return readFileSync(resolve(repoRoot, relativePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function captureObject(value: unknown, path: string): Record<string, unknown> {
  return expectRecord(value, path);
}

function findForbiddenPatterns(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of FORBIDDEN_CAPTURE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) matches.push(pattern.source.replaceAll('\\/', '/'));
  }
  return matches;
}

function schemaFailures(files: readonly string[], reader: CaptureReader): {
  failures: string[];
  unavailable: string[];
  contents: Map<string, string>;
} {
  const failures: string[] = [];
  const unavailable: string[] = [];
  const contents = new Map<string, string>();
  for (const path of files) {
    const text = reader.read(path);
    if (text === undefined) {
      unavailable.push(`${path}: capture became unreachable`);
      continue;
    }
    contents.set(path, text);
    try {
      parseJsonDocument(text, captureObject);
    } catch (error) {
      if (error instanceof JsonContractError) {
        for (const issue of error.issues) failures.push(`${path}: ${issue.path}: ${issue.message}`);
      } else {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { failures, unavailable, contents };
}

function redactionFailures(contents: ReadonlyMap<string, string>): string[] {
  const failures: string[] = [];
  for (const [path, text] of contents) {
    for (const pattern of findForbiddenPatterns(text)) {
      failures.push(`${path.split('/').pop()}: matches forbidden pattern ${pattern}`);
    }
  }
  return failures;
}

function legacyFailure(failures: readonly string[]): string {
  return `[FAIL] AO 0.10 capture redaction gate (Issue #619/#637):\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n`;
}

export function evaluateAoCaptureRedaction(reader: CaptureReader): GateResult {
  const firstFiles = reader.list(CAPTURE_DIRECTORY);
  if (firstFiles === undefined || firstFiles.length === 0) {
    return skipGate(
      'ao-capture-redaction',
      'AO capture corpus is absent or unreachable.',
      [{ class: 'capture-schema', state: 'missing', source: CAPTURE_DIRECTORY }],
      [`No *.raw.json captures are available under ${CAPTURE_DIRECTORY}`],
    );
  }

  const first = schemaFailures(firstFiles, reader);
  if (first.unavailable.length > 0) {
    return skipGate(
      'ao-capture-redaction',
      'AO capture corpus became unreachable during schema load.',
      [{ class: 'capture-schema', state: 'unreachable', source: CAPTURE_DIRECTORY }],
      first.unavailable,
    );
  }
  if (first.failures.length > 0) {
    return failGate(
      'ao-capture-redaction',
      'AO capture schema validation failed.',
      [{ class: 'capture-schema', state: 'present', source: CAPTURE_DIRECTORY }],
      first.failures,
      legacyFailure(first.failures),
    );
  }

  const firstRedactionFailures = redactionFailures(first.contents);
  if (firstRedactionFailures.length > 0) {
    return failGate(
      'ao-capture-redaction',
      'AO capture redaction policy failed.',
      [{ class: 'capture-schema', state: 'present', source: CAPTURE_DIRECTORY }],
      firstRedactionFailures,
      legacyFailure(firstRedactionFailures),
    );
  }

  // Re-list and re-read immediately before the live verdict. A capture removed or replaced
  // after schema validation must never leave behind a stale PASS from the first observation.
  const currentFiles = reader.list(CAPTURE_DIRECTORY);
  if (currentFiles === undefined || currentFiles.join('\n') !== firstFiles.join('\n')) {
    return skipGate(
      'ao-capture-redaction',
      'AO capture corpus changed before live-adoption evaluation.',
      [
        { class: 'capture-schema', state: 'present', source: CAPTURE_DIRECTORY },
        { class: 'live-adoption', state: 'unreachable', source: CAPTURE_DIRECTORY },
      ],
      ['Capture population changed between schema load and live evaluation.'],
    );
  }

  const current = schemaFailures(currentFiles, reader);
  if (current.unavailable.length > 0) {
    return skipGate(
      'ao-capture-redaction',
      'AO capture corpus became unreachable before live-adoption evaluation.',
      [
        { class: 'capture-schema', state: 'present', source: CAPTURE_DIRECTORY },
        { class: 'live-adoption', state: 'unreachable', source: CAPTURE_DIRECTORY },
      ],
      current.unavailable,
    );
  }
  const currentFailures = [...current.failures, ...redactionFailures(current.contents)];
  const evidence: EvidenceObservation[] = [
    { class: 'capture-schema', state: 'present', source: CAPTURE_DIRECTORY },
    { class: 'live-adoption', state: 'present', source: CAPTURE_DIRECTORY },
  ];
  if (currentFailures.length > 0) {
    return failGate(
      'ao-capture-redaction',
      'AO capture corpus changed to an invalid or unredacted live state.',
      evidence,
      currentFailures,
      legacyFailure(currentFailures),
    );
  }

  return passGate(
    'ao-capture-redaction',
    'AO 0.10 capture corpus is schema-valid and contains no forbidden secrets or local paths.',
    ['capture-schema', 'live-adoption'],
    evidence,
    { legacyStdout: '[PASS] AO 0.10 capture redaction gate (Issue #619/#637)\n' },
  );
}
