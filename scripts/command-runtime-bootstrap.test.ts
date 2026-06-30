import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCommandRuntimePath,
  classifyEffectivePath,
  evaluateCommandRuntimePreflight,
  evaluateUncoveredGhArgv,
  parseStructuredCommandOutput,
  scanForbiddenWorkaroundInstructions,
  scanRecoveryDuplication,
  TEMPORARY_REST_UNBLOCK_OWNER_NOTE,
} from './lib/command-runtime-bootstrap.mjs';
import { repoRoot } from './_test-pwsh-helpers.js';

describe('command-runtime bootstrap (#532)', () => {
  const packRoot = repoRoot;
  const packScripts = join(packRoot, 'scripts');

  it('preflight passes in a normal environment with pack scripts first on PATH', () => {
    const inherited = process.env.PATH ?? '/usr/bin:/bin';
    const effectivePath = buildCommandRuntimePath(packScripts, inherited);
    const result = evaluateCommandRuntimePreflight({
      packRoot,
      packScriptsDir: packScripts,
      effectivePath,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.tools?.packGh).toBe(join(packScripts, 'gh'));
  });

  it('missing pwsh on incomplete PATH fails closed with deterministic diagnostic', () => {
    const result = evaluateCommandRuntimePreflight({
      packRoot,
      packScriptsDir: packScripts,
      effectivePath: packScripts,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_pwsh');
    expect(result.diagnostic).toMatch(/missing tool pwsh/);
    expect(result.pathClass).toBe('pack-scripts');
  });

  it('validates pack gh is first on PATH and native gh resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'cmd-runtime-gh-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const packGh = join(scriptsDir, 'gh');
    writeFileSync(packGh, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(packGh, 0o755);
    const nativeGh = join(root, 'native-gh');
    writeFileSync(nativeGh, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
    chmodSync(nativeGh, 0o755);

    const badOrder = evaluateCommandRuntimePreflight({
      packRoot: root,
      packScriptsDir: scriptsDir,
      effectivePath: `${root}:${scriptsDir}`,
      tools: {
        pwsh: '/usr/bin/pwsh',
        node: '/usr/bin/node',
        packGh,
        firstGh: join(root, 'gh'),
        nativeGh,
      },
    });
    expect(badOrder.ok).toBe(false);
    expect(badOrder.reason).toBe('pack_gh_not_first_on_path');

    const noNative = evaluateCommandRuntimePreflight({
      packRoot: root,
      packScriptsDir: scriptsDir,
      effectivePath: scriptsDir,
      tools: {
        pwsh: '/usr/bin/pwsh',
        node: '/usr/bin/node',
        packGh,
        firstGh: packGh,
        nativeGh: null,
        nativeGhError: 'gh-resolve-real-binary: no native gh executable found (skipped 1 non-native candidate(s))',
      },
    });
    expect(noNative.ok).toBe(false);
    expect(noNative.reason).toBe('native_gh_unresolved');
    expect(noNative.diagnostic).toMatch(/gh-resolve-real-binary/);
  });

  it('keeps live preflight success diagnostics off stdout', () => {
    const cli = join(packScripts, 'lib', 'command-runtime-bootstrap.mjs');
    const inherited = process.env.PATH ?? '/usr/bin:/bin';
    const effectivePath = buildCommandRuntimePath(packScripts, inherited);
    const result = spawnSync(process.execPath, [cli, 'livePreflight', '--pack-root', packRoot], {
      env: { ...process.env, PATH: effectivePath },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/\[PASS\] command-runtime bootstrap preflight/);
  });

  it('live preflight fails closed on the actual command PATH without pack scripts first', () => {
    const cli = join(packScripts, 'lib', 'command-runtime-bootstrap.mjs');
    const result = spawnSync(process.execPath, [cli, 'livePreflight', '--pack-root', packRoot], {
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/pack scripts\/gh must be first|missing tool/);
  });

  it('keeps stderr separate from stdout JSON parsing', () => {
    const stderr = 'bash: warning: here-document at line 1 delimited by end-of-file (wanted `EOF`)';
    const stdout = '{"ok":true}';
    const clean = parseStructuredCommandOutput({ stdout, stderr });
    expect(clean.ok).toBe(true);
    expect(clean.value).toEqual({ ok: true });

    const polluted = parseStructuredCommandOutput({ combined: `${stderr}\n${stdout}` });
    expect(polluted.ok).toBe(false);
    expect(polluted.reason).toBe('structured_output_polluted');

    const mixed = parseStructuredCommandOutput({
      stdout: `${stderr}\n${stdout}`,
      stderr: '',
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.reason).toBe('structured_output_polluted');
  });

  it('reports uncovered gh argv shapes for inventory extension', () => {
    const covered = evaluateUncoveredGhArgv(['pr', 'view', '42', '--json', 'state,mergedAt']);
    expect(covered.ok).toBe(true);

    const resolvePrCovered = evaluateUncoveredGhArgv([
      'pr',
      'view',
      '42',
      '--repo',
      'owner/repo',
      '--json',
      'number,url,title,headRefName,baseRefName,isDraft',
    ]);
    expect(resolvePrCovered.ok).toBe(true);
    expect(resolvePrCovered.route).toBe('pr-view');

    const uncovered = evaluateUncoveredGhArgv([
      'pr',
      'view',
      '42',
      '--repo',
      'owner/repo',
      '--json',
      'number,url,title,headRefName,baseRefName,isDraft,commits',
    ]);
    expect(uncovered.ok).toBe(false);
    expect(uncovered.reason).toBe('gh_inventory_gap');
    expect(uncovered.diagnostic).toMatch(/do not create temp gh wrappers/i);
  });

  it('static guard rejects executable workaround instructions', () => {
    const bad = scanForbiddenWorkaroundInstructions(
      'Run mkdir -p /tmp/gh-rest-bin && write a temporary gh wrapper there.',
      'fixture.md',
    );
    expect(bad.length).toBeGreaterThan(0);

    const allowed = scanForbiddenWorkaroundInstructions(
      'Forbidden transports: agents MUST NOT improvise raw curl to api.github.com or temporary `gh` shims.',
      'fixture.md',
    );
    expect(allowed).toEqual([]);
  });

  it('does not duplicate recovery cleanup recipes in bootstrap artifacts', () => {
    const violations = scanRecoveryDuplication('git worktree remove --force ./wt', 'fixture.mjs');
    expect(violations.length).toBeGreaterThan(0);
    expect(TEMPORARY_REST_UNBLOCK_OWNER_NOTE).toMatch(/#530\/#531/);
  });

  it('classifies effective PATH without leaking secrets', () => {
    expect(classifyEffectivePath('/pack/scripts:/usr/bin:/home/x/.ao/bin', '/pack/scripts')).toBe(
      'pack-scripts,usr-bin,ao-bin',
    );
  });
});
