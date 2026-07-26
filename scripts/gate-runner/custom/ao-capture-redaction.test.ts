import { describe, expect, it } from 'vitest';
import {
  CAPTURE_DIRECTORY,
  evaluateAoCaptureRedaction,
  FORBIDDEN_CAPTURE_PATTERNS,
  type CaptureReader,
} from './ao-capture-redaction.ts';

function reader(snapshots: readonly (Readonly<Record<string, string>> | undefined)[]): CaptureReader {
  let listCall = 0;
  let active = snapshots[0];
  return {
    list(relativeDirectory) {
      active = snapshots[Math.min(listCall++, snapshots.length - 1)];
      if (active === undefined) return undefined;
      return Object.keys(active)
        .filter((path) => path.startsWith(`${relativeDirectory}/`) && path.endsWith('.raw.json'))
        .sort();
    },
    read(relativePath) {
      return active?.[relativePath];
    },
  };
}

const clean = {
  [`${CAPTURE_DIRECTORY}/session-ls.raw.json`]: JSON.stringify({ sessions: [{ id: 's1', state: 'working' }] }),
  [`${CAPTURE_DIRECTORY}/daemon-status.raw.json`]: JSON.stringify({ status: 'ok' }),
};

describe('custom capture-schema/live-adoption redaction gate', () => {
  it('passes only with capture-schema and live-adoption evidence', () => {
    const result = evaluateAoCaptureRedaction(reader([clean, clean]));
    expect(result.status).toBe('PASS');
    expect(result.evidence.map((item) => item.class)).toEqual(['capture-schema', 'live-adoption']);
    expect(result.legacyStdout).toBe('[PASS] AO 0.10 capture redaction gate (Issue #619/#637)\n');
  });

  it.each([
    ['ghp_', 'ghp_secret'],
    ['gho_', 'gho_secret'],
    ['ghu_', 'ghu_secret'],
    ['ghs_', 'ghs_secret'],
    ['ghr_', 'ghr_secret'],
    ['github_pat_', 'github_pat_secret'],
    ['credential URL', 'https://user:secret@example.test/path'],
  ])('fails the real negative fixture class %s', (_label, secret) => {
    const contaminated = {
      [`${CAPTURE_DIRECTORY}/leak.raw.json`]: JSON.stringify({ value: secret }),
    };
    const result = evaluateAoCaptureRedaction(reader([contaminated, contaminated]));
    expect(result.status).toBe('FAIL');
    expect(result.legacyStdout).toContain('[FAIL] AO 0.10 capture redaction gate');
  });

  it('fails malformed capture schema', () => {
    const malformed = { [`${CAPTURE_DIRECTORY}/bad.raw.json`]: '{' };
    const result = evaluateAoCaptureRedaction(reader([malformed]));
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('JSON');
  });

  it('SKIPs when the required capture surface is absent', () => {
    const result = evaluateAoCaptureRedaction(reader([undefined]));
    expect(result.status).toBe('SKIP');
    expect(result.reason).toContain('absent or unreachable');
  });

  it('SKIPs a race where the capture population disappears after schema load', () => {
    const result = evaluateAoCaptureRedaction(reader([clean, undefined]));
    expect(result.status).toBe('SKIP');
    expect(result.evidence.some((item) => item.class === 'live-adoption' && item.state === 'unreachable')).toBe(true);
  });

  it('keeps the forbidden-pattern family complete', () => {
    expect(FORBIDDEN_CAPTURE_PATTERNS.map((pattern) => pattern.source)).toEqual(expect.arrayContaining([
      'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'AKIA[0-9A-Z]{16}',
    ]));
  });
});
