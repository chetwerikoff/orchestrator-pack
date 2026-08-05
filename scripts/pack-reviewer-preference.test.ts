import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.js';
import {
  getPackReviewerPreferencePath,
  readPackReviewerPreference,
  replacePreferenceFile,
  writePackReviewerPreference,
} from './lib/pack-reviewer-preference.ts';
import {
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
  return { root, filePath: join(root, 'pack-reviewer.json') };
}

describe('persistent pack reviewer preference', () => {
  it('uses the canonical XDG/HOME path and rejects missing roots', () => {
    expect(getPackReviewerPreferencePath({
      XDG_CONFIG_HOME: '/tmp/opk-xdg',
      HOME: '/tmp/opk-home',
    })).toBe('/tmp/opk-xdg/orchestrator-pack/pack-reviewer.json');
    expect(getPackReviewerPreferencePath({
      HOME: '/tmp/opk-home',
    })).toBe('/tmp/opk-home/.config/orchestrator-pack/pack-reviewer.json');
    expect(() => getPackReviewerPreferencePath({})).toThrow(/CONFIG_ROOT_MISSING/);
  });

  it('fails closed on a missing config root instead of using legacy environment state', () => {
    const resolution = resolvePackReviewerResolution({
      XDG_CONFIG_HOME: '',
      HOME: '',
      PACK_REVIEWER: 'codex',
    });

    expect(resolution).toMatchObject({
      reviewer: null,
      source: 'none',
      preferencePath: null,
    });
    expect(resolution.errorMessage).toMatch(/CONFIG_ROOT_MISSING/);
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
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 'orchestrator-pack/pack-reviewer-preference/v1',
      reviewer: 'gpt',
    });
    if (process.platform !== 'win32') {
      expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('retains the previous preference when Windows replacement and rollback both fail', () => {
    let renameCalls = 0;
    const renameSync = vi.fn((source: string, destination: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        throw Object.assign(new Error('destination exists'), { code: 'EPERM' });
      }
      if (renameCalls === 3) {
        throw Object.assign(new Error('replacement failed'), { code: 'EEXIST' });
      }
      if (renameCalls === 4) {
        throw Object.assign(new Error('rollback failed'), { code: 'EPERM' });
      }
      void source;
      void destination;
    }) as typeof import('node:fs').renameSync;
    const rmSync = vi.fn() as typeof import('node:fs').rmSync;

    expect(() => replacePreferenceFile(
      '/tmp/new-preference.tmp',
      '/tmp/live-preference.json',
      { renameSync, rmSync },
      'win32',
    )).toThrow(/previous preference is preserved/);
    expect(renameSync).toHaveBeenCalledTimes(4);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('prefers the saved reviewer over stale legacy environment state', () => {
    const { filePath } = preferenceFixture();
    writePackReviewerPreference('gpt', filePath);

    const resolution = resolvePackReviewerResolution(
      { PACK_REVIEWER: 'codex' },
      { preferenceFilePath: filePath },
    );
    expect(resolution.reviewer).toBe('gpt');
    expect(resolution.source).toBe('persistent-preference');
  });

  it('prefers an explicit invocation binding over the saved reviewer', () => {
    const { filePath } = preferenceFixture();
    writePackReviewerPreference('gpt', filePath);

    const resolution = resolvePackReviewerResolution(
      {
        PACK_REVIEWER: 'codex',
        PACK_REVIEW_BOUND_REVIEWER: 'claude',
      },
      { preferenceFilePath: filePath },
    );
    expect(resolution.reviewer).toBe('claude');
    expect(resolution.source).toBe('invocation-bound');
  });

  it('uses legacy environment state only when no preference exists', () => {
    const { filePath } = preferenceFixture();

    const resolution = resolvePackReviewerResolution(
      { PACK_REVIEWER: 'codex' },
      { preferenceFilePath: filePath },
    );
    expect(resolution.reviewer).toBe('codex');
    expect(resolution.source).toBe('legacy-env');
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

  it('does not read lower layers when the invocation binding is invalid', () => {
    const { filePath } = preferenceFixture();
    writePackReviewerPreference('gpt', filePath);
    const readPreference = vi.fn(() => readPackReviewerPreference(filePath));

    const resolution = resolvePackReviewerResolution(
      {
        PACK_REVIEWER: 'codex',
        PACK_REVIEW_BOUND_REVIEWER: 'not-a-reviewer',
      },
      { preferenceFilePath: filePath, readPreference },
    );

    expect(resolution.reviewer).toBeNull();
    expect(resolution.source).toBe('none');
    expect(readPreference).not.toHaveBeenCalled();
  });

  it('rejects additional schema keys instead of accepting them', () => {
    const { filePath } = preferenceFixture();
    writeFileSync(filePath, JSON.stringify({
      schema: 'orchestrator-pack/pack-reviewer-preference/v1',
      reviewer: 'gpt',
      extra: 'must-reject',
    }));

    expect(readPackReviewerPreference(filePath)).toMatchObject({
      status: 'invalid',
    });
  });

  it('supports the canonical set/status CLI and JSON status contract', () => {
    const { root } = preferenceFixture();
    const script = join(process.cwd(), 'scripts/pack-reviewer-config.ts');
    const env = { ...process.env, XDG_CONFIG_HOME: root, HOME: '', PACK_REVIEWER: 'codex' };
    delete env.PACK_REVIEW_BOUND_REVIEWER;

    const set = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', script, 'set', 'gpt'],
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });
    expect(set.exitCode, set.stderr).toBe(0);

    const status = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', script, 'status', '--json'],
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      schema: 'pack-reviewer-status/v1',
      savedReviewer: 'gpt',
      effectiveReviewer: 'gpt',
      source: 'persistent-preference',
    });
  });

  it('keeps the package JSON status stream free of node-major diagnostics', () => {
    const { root } = preferenceFixture();
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = runProcessSync({
      command: npm,
      args: ['run', '--silent', 'pack-reviewer-config', '--', 'status', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, XDG_CONFIG_HOME: root, HOME: '', PACK_REVIEWER: 'gpt' },
      encoding: 'utf8',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Node\.js .*satisfies/);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'pack-reviewer-status/v1',
      effectiveReviewer: 'gpt',
      source: 'legacy-env',
    });
  });
});
