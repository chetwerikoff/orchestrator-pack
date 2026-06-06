import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSubmitArgvIsEnterOnly,
  buildSubmitEnterArgv,
  evaluateSubmitAdapterGate,
} from '../docs/worker-input-draft-submit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submitLib = path.join(repoRoot, 'scripts/lib/Submit-WorkerInputDraft.ps1');

function runSubmitAdapter(params: {
  sessionId: string;
  expectedSessionId: string;
  dryRun?: boolean;
}): { submitted: boolean; reason: string; enter?: boolean } {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `
      . '${submitLib}'
      $r = Invoke-WorkerInputDraftSubmit -SessionId '${params.sessionId}' -ExpectedSessionId '${params.expectedSessionId}' -DryRun:$${params.dryRun ? 'true' : 'false'}
      $r | ConvertTo-Json -Compress
    `,
  ];
  const result = spawnSync('pwsh', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout.trim()) as {
    submitted: boolean;
    reason: string;
    enter?: boolean;
  };
}

describe('submit adapter gate (AC9)', () => {
  it('fail-closed on wrong session — no Enter', () => {
    const gate = evaluateSubmitAdapterGate({
      sessionId: 'opk-a',
      expectedSessionId: 'opk-b',
      tmuxAvailable: true,
      tmuxSessionExists: true,
      tmuxTarget: 'opk-a',
    });
    expect(gate.ok).toBe(false);
    expect(gate.enter).toBe(false);
    expect(gate.reason).toBe('wrong_session');
  });

  it('fail-closed when tmux unavailable', () => {
    const gate = evaluateSubmitAdapterGate({
      sessionId: 'opk-a',
      expectedSessionId: 'opk-a',
      tmuxAvailable: false,
      tmuxSessionExists: false,
    });
    expect(gate.ok).toBe(false);
    expect(gate.enter).toBe(false);
    expect(gate.reason).toBe('tmux_unavailable');
  });

  it('fail-closed when tmux session missing', () => {
    const gate = evaluateSubmitAdapterGate({
      sessionId: 'missing-session',
      expectedSessionId: 'missing-session',
      tmuxAvailable: true,
      tmuxSessionExists: false,
    });
    expect(gate.ok).toBe(false);
    expect(gate.enter).toBe(false);
    expect(gate.reason).toBe('tmux_session_missing');
  });

  it('PowerShell adapter returns fail-closed for wrong session', () => {
    const result = runSubmitAdapter({
      sessionId: 'opk-a',
      expectedSessionId: 'opk-b',
      dryRun: true,
    });
    expect(result.submitted).toBe(false);
    expect(result.reason).toBe('wrong_session');
    expect(result.enter).toBe(false);
  });

  it('PowerShell adapter dry-run succeeds for live tmux session opk-19', () => {
    const check = spawnSync('tmux', ['has-session', '-t', 'opk-19'], { encoding: 'utf8' });
    if (check.status !== 0) {
      return;
    }
    const result = runSubmitAdapter({
      sessionId: 'opk-19',
      expectedSessionId: 'opk-19',
      dryRun: true,
    });
    expect(result.submitted).toBe(true);
    expect(result.reason).toBe('dry_run');
    expect(result.enter).toBe(false);
  });
});

describe('submit behavior evidence (AC10)', () => {
  it('documents Enter-only tmux dispatch (observed AO send.js retry pattern)', () => {
    const argv = buildSubmitEnterArgv('opk-worker');
    assertSubmitArgvIsEnterOnly(argv);
    expect(argv[3]).toBe('Enter');
    expect(argv.join(' ')).not.toMatch(/paste|load-buffer|Escape|-l/);
  });
});

describe('degrade not crash (AC11)', () => {
  it('adapter returns structured failure without throwing', () => {
    const result = runSubmitAdapter({
      sessionId: 'definitely-not-a-real-tmux-session-xyz',
      expectedSessionId: 'definitely-not-a-real-tmux-session-xyz',
      dryRun: false,
    });
    expect(result.submitted).toBe(false);
    expect(result.reason).toMatch(/tmux_session_missing|tmux_unavailable/);
  });
});
