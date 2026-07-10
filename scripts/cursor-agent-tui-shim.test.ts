import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from './_test-pwsh-helpers.js';

const shimSource = path.join(repoRoot, 'scripts/cursor-agent-tui-shim.sh');
const mockReal = path.join(repoRoot, 'tests/fixtures/cursor-agent-tui-shim/mock-cursor-agent-real.sh');
const staleShim = path.join(repoRoot, 'tests/fixtures/cursor-agent-tui-shim/stale-shim.sh');

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

function trackHome(home: string) {
  homes.push(home);
  return home;
}

function makeHome() {
  return trackHome(mkdtempSync(path.join(tmpdir(), 'opk-cursor-shim-')));
}

function fixtureEnv(home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    OPK_CURSOR_AGENT_HOME: home,
    PATH: '/usr/bin:/bin:/snap/bin',
    OPK_MOCK_CURSOR_AGENT_SLEEP_SECONDS: '1',
    ...extra,
  };
  if (!('AO_SESSION_ID' in extra)) {
    delete env.AO_SESSION_ID;
  }
  return env as NodeJS.ProcessEnv;
}

function versionsDir(home: string) {
  return path.join(home, '.local/share/cursor-agent/versions/2026.07.10-test');
}

function installMockReal(home: string) {
  const dir = versionsDir(home);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'cursor-agent');
  copyFileSync(mockReal, target);
  chmodSync(target, 0o755);
  return target;
}

function runPwshFile(scriptRel: string, home: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, scriptRel), ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: fixtureEnv(home, extraEnv),
    },
  );
  return result;
}

function runPwshCommand(command: string, home: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: fixtureEnv(home, extraEnv),
  });
}

function installFixture(home: string) {
  installMockReal(home);
  const result = runPwshFile('scripts/install-cursor-agent-tui-shim.ps1', home, ['-Quiet']);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function topology(home: string) {
  const result = runPwshCommand(
    `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Get-CursorAgentTuiShimTopology | ConvertTo-Json -Compress)`,
    home,
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    Pass: boolean;
    Reason: string;
    ClobberShape: string;
  };
}

function ptyProbe(
  home: string,
  probeEnv: Record<string, string>,
  argv: string[],
  expectMode: 'translate' | 'passthrough',
) {
  const envJson = JSON.stringify(probeEnv).replace(/'/g, "''");
  const argvJson = JSON.stringify(argv).replace(/'/g, "''");
  const script = `
. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'
$env = ConvertFrom-Json '${envJson}' -AsHashtable
$argv = ConvertFrom-Json '${argvJson}'
$r = Invoke-CursorAgentTuiShimPtyProbe -ProbeEnv $env -Argv $argv -TimeoutSeconds 3 -ExpectMode '${expectMode}'
$r | ConvertTo-Json -Compress
`;
  const result = runPwshCommand(script, home);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as { Pass: boolean; Reason: string; Output: string };
}

describe('cursor-agent TUI shim (Issue #725)', () => {
  it('AC#1: shim source is tracked in the repository', () => {
    const text = readFileSync(shimSource, 'utf8');
    expect(text).toContain('orchestrator-pack-[0-9]+');
    expect(text).toContain('stream-json');
  });

  it('AC#2: install entry point is idempotent', () => {
    const home = makeHome();
    installMockReal(home);
    const first = runPwshFile('scripts/install-cursor-agent-tui-shim.ps1', home, ['-Quiet']);
    const second = runPwshFile('scripts/install-cursor-agent-tui-shim.ps1', home, ['-Quiet']);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(topology(home).Pass).toBe(true);
  });

  it('AC#3 / positive-outcome: translate branch strips headless flags for worker signature', () => {
    const home = makeHome();
    installFixture(home);
    const probe = ptyProbe(home, { AO_SESSION_ID: 'orchestrator-pack-93' }, ['-p', 'stream-json'], 'translate');
    expect(probe.Pass).toBe(true);
    expect(probe.Output).toMatch(/CURSOR_AGENT_TUI_BANNER/);
  });

  it('AC#4: offline translate-path verifier PASS on installed fixture', () => {
    const home = makeHome();
    installFixture(home);
    const result = runPwshFile('scripts/verify-cursor-agent-tui-shim.ps1', home, ['-SkipTrustWatcherCheck', '-Quiet']);
    expect(result.status).toBe(0);
  });

  it('AC#5: passthrough path keeps stock headless behavior', () => {
    const home = makeHome();
    installFixture(home);
    const probe = ptyProbe(home, {}, ['-p', 'stream-json'], 'passthrough');
    expect(probe.Pass).toBe(true);
    expect(probe.Output).toMatch(/No prompt provided/);
  });

  it('AC#6: stale argv semantics fail behavioral probe (fail-loud)', () => {
    const home = makeHome();
    installMockReal(home);
    const installPath = path.join(home, '.local/share/orchestrator-pack/cursor-agent-tui-shim.sh');
    mkdirSync(path.dirname(installPath), { recursive: true });
    copyFileSync(staleShim, installPath);
    chmodSync(installPath, 0o755);
    const binDir = path.join(home, '.local/bin');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(installPath, path.join(binDir, 'cursor-agent'));
    expect(topology(home).Pass).toBe(true);
    const probe = ptyProbe(home, { AO_SESSION_ID: 'orchestrator-pack-93' }, ['-p', 'stream-json'], 'translate');
    expect(probe.Pass).toBe(false);
  });

  it('AC#7 / matrix (c): missing versions directory emits loud diagnostic', () => {
    const home = makeHome();
    installFixture(home);
    rmSync(path.join(home, '.local/share/cursor-agent'), { recursive: true, force: true });
    const result = spawnSync('bash', [path.join(home, '.local/bin/cursor-agent'), '-p', 'stream-json'], {
      env: fixtureEnv(home, { AO_SESSION_ID: 'orchestrator-pack-93' }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toMatch(/\[cursor-agent-tui-shim\] FATAL/);
  });

  it('AC#8: trust-watcher running-state is distinct from shim topology', () => {
    const home = makeHome();
    installFixture(home);
    const topo = topology(home);
    const result = runPwshCommand(
      `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Test-CursorAgentTrustWatcherRunning | ConvertTo-Json -Compress)`,
      home,
    );
    expect(result.status).toBe(0);
    const watcher = JSON.parse(result.stdout.trim()) as { Pass: boolean; Reason: string };
    expect(typeof watcher.Pass).toBe('boolean');
    if (watcher.Pass) {
      expect(watcher.Reason).toMatch(/^pid=/);
    } else {
      expect(watcher.Reason).toMatch(/trust-watcher process not found/);
    }
    expect(topo.Pass).toBe(true);
  });

  it('AC#9: rollback steps documented in migration_notes.md', () => {
    const notes = readFileSync(path.join(repoRoot, 'docs/migration_notes.md'), 'utf8');
    expect(notes).toMatch(/cursor-agent TUI shim/i);
    expect(notes).toMatch(/ln -sf/);
    expect(notes).toMatch(/OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE/);
    expect(notes).not.toMatch(/~\/\.local\/bin\/agent.*shim/i);
  });

  it('AC#10: install never mutates ~/.local/bin/agent', () => {
    const home = makeHome();
    installMockReal(home);
    const agentPath = path.join(home, '.local/bin/agent');
    mkdirSync(path.dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, 'stock-agent-token', 'utf8');
    const before = readFileSync(agentPath, 'utf8');
    installFixture(home);
    const after = readFileSync(agentPath, 'utf8');
    expect(after).toBe(before);
  });

  it('AC#11: review-session AO_SESSION_ID stays on passthrough', () => {
    const home = makeHome();
    installFixture(home);
    const probe = ptyProbe(
      home,
      { AO_SESSION_ID: 'review-orchestrator-pack-93' },
      ['-p', 'stream-json'],
      'passthrough',
    );
    expect(probe.Pass).toBe(true);
  });

  it('AC#11: piped stdout consumer stays on passthrough', () => {
    const home = makeHome();
    installFixture(home);
    const cursorAgent = path.join(home, '.local/bin/cursor-agent');
    const result = spawnSync('bash', ['-lc', `${cursorAgent} -p stream-json | head -1`], {
      env: fixtureEnv(home, { AO_SESSION_ID: 'orchestrator-pack-93' }),
      encoding: 'utf8',
    });
    expect(result.stderr).toMatch(/No prompt provided/);
    expect(result.stdout).not.toMatch(/CURSOR_AGENT_TUI_BANNER/);
  });

  it('matrix (a): symlink repoint drift is healed by self-heal', () => {
    const home = makeHome();
    installFixture(home);
    const realBinary = versionsDir(home) + '/cursor-agent';
    const symlink = path.join(home, '.local/bin/cursor-agent');
    rmSync(symlink);
    symlinkSync(realBinary, symlink);
    expect(topology(home).ClobberShape).toBe('symlink-repoint');
    const result = runPwshCommand(
      `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Invoke-CursorAgentTuiShimSelfHeal -PackRoot '${repoRoot.replace(/'/g, "''")}' -Source test -Quiet | ConvertTo-Json -Compress)`,
      home,
    );
    expect(result.status).toBe(0);
    const heal = JSON.parse(result.stdout.trim()) as { Healed: boolean; Alerted: boolean };
    expect(heal.Healed).toBe(true);
    expect(heal.Alerted).toBe(true);
    expect(topology(home).Pass).toBe(true);
  });

  it('rollback: self-heal disable env leaves stock symlink in place', () => {
    const home = makeHome();
    installFixture(home);
    const realBinary = `${versionsDir(home)}/cursor-agent`;
    const symlink = path.join(home, '.local/bin/cursor-agent');
    rmSync(symlink);
    symlinkSync(realBinary, symlink);
    const result = runPwshCommand(
      `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Invoke-CursorAgentTuiShimSelfHeal -PackRoot '${repoRoot.replace(/'/g, "''")}' -Source test -Quiet | ConvertTo-Json -Compress)`,
      home,
      { OPK_CURSOR_AGENT_SHIM_SELF_HEAL_DISABLE: '1' },
    );
    expect(result.status).toBe(0);
    const heal = JSON.parse(result.stdout.trim()) as { Healed: boolean; Message: string };
    expect(heal.Healed).toBe(false);
    expect(heal.Message).toMatch(/self-heal disabled/);
    expect(topology(home).ClobberShape).toBe('symlink-repoint');
  });

  it('matrix (b): regular-file clobber is replaced with shim symlink', () => {
    const home = makeHome();
    installFixture(home);
    const symlink = path.join(home, '.local/bin/cursor-agent');
    rmSync(symlink);
    writeFileSync(symlink, '#!/bin/sh\nexit 0\n', 'utf8');
    expect(topology(home).ClobberShape).toBe('regular-file');
    const result = runPwshCommand(
      `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Invoke-CursorAgentTuiShimSelfHeal -PackRoot '${repoRoot.replace(/'/g, "''")}' -Source test -Quiet | ConvertTo-Json -Compress)`,
      home,
    );
    expect(result.status).toBe(0);
    expect(topology(home).Pass).toBe(true);
  });

  it('matrix (d): deleted pack shim install target is restored by reinstall', () => {
    const home = makeHome();
    installFixture(home);
    const installPath = path.join(home, '.local/share/orchestrator-pack/cursor-agent-tui-shim.sh');
    rmSync(installPath);
    expect(topology(home).Pass).toBe(false);
    const result = runPwshFile('scripts/install-cursor-agent-tui-shim.ps1', home, ['-Quiet']);
    expect(result.status).toBe(0);
    expect(existsSync(installPath)).toBe(true);
    expect(topology(home).Pass).toBe(true);
  });

  it('matrix (e): trust-watcher-down surfaces distinct verify failure', () => {
    const home = makeHome();
    installFixture(home);
    const result = runPwshCommand(
      `. '${path.join(repoRoot, 'scripts/lib/Cursor-Agent-TuiShim.ps1').replace(/'/g, "''")}'; (Invoke-CursorAgentTuiShimOfflineVerification -PackRoot '${repoRoot.replace(/'/g, "''")}' -Quiet | ConvertTo-Json -Compress -Depth 5)`,
      home,
      { OPK_FORCE_TRUST_WATCHER_DOWN: '1' },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as {
      Pass: boolean;
      Results: Array<{ Name: string; Result: { Reason: string } }>;
    };
    expect(report.Pass).toBe(false);
    const watcherRow = report.Results.find((r) => r.Name === 'trust-watcher-running');
    expect(watcherRow?.Result.Reason).toMatch(/trust-watcher-down/);
  });

  it('worktree-trust-watcher wires self-heal without rewriting poll/trust core', () => {
    const watcher = readFileSync(path.join(repoRoot, 'scripts/orchestrator-worktree-trust-watcher.ps1'), 'utf8');
    expect(watcher).toMatch(/Invoke-CursorAgentTuiShimWatcherSelfHeal/);
    expect(watcher).toMatch(/Register-TrustedPath/);
    expect(watcher).toMatch(/Invoke-CursorAgentTuiShimWatcherSelfHeal[\s\S]*Start-Sleep/);
  });
});
