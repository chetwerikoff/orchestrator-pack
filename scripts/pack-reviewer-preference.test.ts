import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPackReviewerPreferencePath,
  readPackReviewerPreference,
  writePackReviewerPreference,
} from './lib/pack-reviewer-preference.ts';
import {
  resolvePackReviewerFromEnv,
  resolvePackReviewerResolution,
} from './lib/resolve-pack-reviewer.ts';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function preferenceFixture(): { root: string; filePath: string } {
  const root = mkdtempSync(join('/tmp', 'opk-reviewer-preference-'));
  temporaryRoots.push(root);
  return { root, filePath: join(root, 'reviewer.json') };
}

describe('persistent pack reviewer preference', () => {
  it('uses XDG_CONFIG_HOME and falls back to the user config directory', () => {
    expect(getPackReviewerPreferencePath({
      XDG_CONFIG_HOME: '/tmp/opk-xdg',
      HOME: '/tmp/opk-home',
    })).toBe('/tmp/opk-xdg/orchestrator-pack/reviewer.json');
    expect(getPackReviewerPreferencePath({
      HOME: '/tmp/opk-home',
    })).toBe('/tmp/opk-home/.config/orchestrator-pack/reviewer.json');
    expect(getPackReviewerPreferencePath({}, '/tmp/opk-homedir'))
      .toBe('/tmp/opk-homedir/.config/orchestrator-pack/reviewer.json');
  });

  it('persists a valid reviewer and rereads it', () => {
    const { filePath } = preferenceFixture();
    const result = writePackReviewerPreference('gpt', filePath);

    expect(result.status).toBe('valid');
    expect(result.reviewer).toBe('gpt');
    expect(readPackReviewerPreference(filePath)).toMatchObject({
      status: 'valid',
      reviewer: 'gpt',
    });
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('prefers the saved reviewer over stale legacy environment state', () => {
    const { filePath } = preferenceFixture();
    writePackReviewerPreference('gpt', filePath);

    expect(resolvePackReviewerFromEnv(
      { PACK_REVIEWER: 'codex' },
      { preferenceFilePath: filePath },
    )).toBe('gpt');
  });

  it('prefers an explicit invocation binding over the saved reviewer', () => {
    const { filePath } = preferenceFixture();
    writePackReviewerPreference('gpt', filePath);

    expect(resolvePackReviewerFromEnv(
      {
        PACK_REVIEWER: 'codex',
        PACK_REVIEW_BOUND_REVIEWER: 'claude',
      },
      { preferenceFilePath: filePath },
    )).toBe('claude');
  });

  it('uses legacy environment state only when no preference exists', () => {
    const { filePath } = preferenceFixture();

    expect(resolvePackReviewerFromEnv(
      { PACK_REVIEWER: 'codex' },
      { preferenceFilePath: filePath },
    )).toBe('codex');
  });

  it('fails closed on malformed persistent state instead of falling back', () => {
    const { filePath } = preferenceFixture();
    writeFileSync(filePath, '{"schema":"pack-reviewer-preference/v0","reviewer":"gpt"}\n');

    const resolution = resolvePackReviewerResolution(
      { PACK_REVIEWER: 'codex' },
      { preferenceFilePath: filePath },
    );

    expect(resolution.reviewer).toBeNull();
    expect(resolution.errorMessage).toMatch(/Invalid persistent reviewer preference/);
  });
});
