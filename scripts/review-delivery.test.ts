import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDeterministicDeliveryId,
  buildDeterministicDeliveryKey,
  canEvictLifecycleEntry,
  evaluateDeterministicJournalAdmission,
  hashReviewFindings,
  readLifecycleStore,
  upsertLifecycleEntry,
  writeLifecycleStore,
  TERMINAL_DELIVERED,
} from '../docs/review-delivery-lifecycle.mjs';
import {
  buildScriptedReviewDeliveryMessage,
  parsePackReviewTerminalStdout,
} from '../docs/scripted-review-post-submit-delivery.mjs';
import { repoRoot, runPwsh, psString } from './_test-pwsh-helpers.js';

const headSha = 'abc123def4567890abcdef1234567890abcdef12';
const prNumber = 718;
const cleanStdout = JSON.stringify({
  verdict: 'clean',
  findingCount: 0,
  findings: [],
});
const findingsStdout = JSON.stringify({
  verdict: 'findings',
  findingCount: 1,
  findings: [{ id: 'F1', summary: 'test finding' }],
});

function deliveryKey(findings: unknown[]): string {
  const key = buildDeterministicDeliveryKey({
    prNumber,
    headSha,
    verdictSource: 'wrapper-stdout',
    findingsHash: hashReviewFindings(findings),
  });
  if (!key) {
    throw new Error('delivery key required for test fixture');
  }
  return key;
}

describe('review delivery lifecycle helpers', () => {
  it('review delivery lifecycle ttl safety: eviction rejected while PR actionable and delivery non-terminal', () => {
    const entry = {
      terminalStatus: '',
      state: 'verdict_recorded',
      lastUpdatedMs: Date.now(),
    };
    const result = canEvictLifecycleEntry({ entry, prActionable: true, nowMs: Date.now() + 1_000_000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('non_terminal_actionable_pr');
  });

  it('review delivery deterministic journal dedup: terminal delivered duplicate is no-op', () => {
    const key = deliveryKey([]);
    const journal = {
      prior: {
        deliveryId: 'sess:pack-send:det:abc',
        deterministicKey: key,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
      },
    };
    const admission = evaluateDeterministicJournalAdmission(journal, {
      deterministicKey: key,
      findingsHash: hashReviewFindings([]),
    });
    expect(admission.action).toBe('no_op_terminal');
  });

  it('review delivery deterministic journal dedup: claimed-not-delivered crash resumes exactly one send', () => {
    const key = deliveryKey([]);
    const journal = {
      prior: {
        deliveryId: 'sess:pack-send:det:abc',
        deterministicKey: key,
        dispatchOutcome: 'dispatch_in_flight',
        lifecycleState: 'delivery_claimed',
      },
    };
    const admission = evaluateDeterministicJournalAdmission(journal, {
      deterministicKey: key,
      findingsHash: hashReviewFindings([]),
    });
    expect(admission.action).toBe('resume');
  });

  it('review delivery duplicate wrapper run different findings: escalates instead of second send', () => {
    const priorFindings = [{ id: 'F1', summary: 'first finding' }];
    const nextFindings = [{ id: 'F2', summary: 'changed finding' }];
    const priorKey = buildDeterministicDeliveryKey({
      prNumber,
      headSha,
      verdictSource: 'wrapper-stdout',
      findingsHash: hashReviewFindings(priorFindings),
    })!;
    const nextKey = buildDeterministicDeliveryKey({
      prNumber,
      headSha,
      verdictSource: 'wrapper-stdout',
      findingsHash: hashReviewFindings(nextFindings),
    })!;
    expect(priorKey).not.toBe(nextKey);

    const journal = {
      prior: {
        deliveryId: 'sess:pack-send:det:abc',
        deterministicKey: priorKey,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
        findingsHash: hashReviewFindings(priorFindings),
      },
    };
    const admission = evaluateDeterministicJournalAdmission(journal, {
      deterministicKey: nextKey,
      findingsHash: hashReviewFindings(nextFindings),
    });
    expect(admission.ok).toBe(false);
    expect(admission.action).toBe('escalate_supersede');
    expect(admission.reason).toBe('different_findings_same_head');
  });
});

describe('review delivery stdout parsing', () => {
  it('stdout delivery empty daemon corpus: parses clean and changes_requested terminal stdout', () => {
    const clean = parsePackReviewTerminalStdout(cleanStdout);
    expect(clean.ok).toBe(true);
    expect(clean.gateVerdict).toBe('approved');

    const findings = parsePackReviewTerminalStdout(findingsStdout);
    expect(findings.ok).toBe(true);
    expect(findings.gateVerdict).toBe('changes_requested');
    expect(findings.findings).toHaveLength(1);
  });

  it('stdout delivery empty daemon corpus: builds delivery message without daemon run id', () => {
    const key = deliveryKey([]);
    const message = buildScriptedReviewDeliveryMessage({
      prNumber,
      deliveryKey: key,
      headSha,
      gateVerdict: 'approved',
    });
    expect(message.ok).toBe(true);
    expect(message.message).toContain(`PR #${prNumber}`);
    expect(message.message).not.toMatch(/run_not_visible/);
  });
});

describe('review delivery lifecycle crash resume', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('review delivery lifecycle crash resume: C4a escalates without send when verdict snapshot missing', () => {
    const script = [
      `. ${psString(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'))}`,
      "$parsed = @{ ok = $true; gateVerdict = 'approved'; packVerdict = 'clean'; findings = @() }",
      `$result = Invoke-ScriptedReviewStdoutDelivery -RepoRoot ${psString(repoRoot)} -WrapperStdout ${psString(cleanStdout)} -ParsedStdout $parsed -PrNumber ${prNumber} -TargetSha ${psString(headSha)} -SimulateCrashBeforeVerdictPersist`,
      '$result | ConvertTo-Json -Compress',
    ].join('\n');
    const result = JSON.parse(runPwsh(script));
    expect(result.reason).toBe('verdict_snapshot_lost');
  });

  it('review delivery lifecycle crash resume: C4b without resume hook delivery missing, with hook exactly one send', () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'review-delivery-store-'));
    tempDirs.push(storeDir);
    const storePath = path.join(storeDir, 'lifecycle.json');
    const key = deliveryKey([]);
    let store = readLifecycleStore(storePath);
    ({ store } = upsertLifecycleEntry(store, key, {
      state: 'verdict_recorded',
      prNumber,
      headSha,
      gateVerdict: 'approved',
      findingsHash: hashReviewFindings([]),
      stdoutSnapshot: cleanStdout,
    }));
    writeLifecycleStore(storePath, store);

    const resumeScript = [
      `. ${psString(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'))}`,
      `$sessions = @(@{ id = 'worker-718'; sessionId = 'worker-718'; name = 'worker-718'; role = 'worker'; status = 'working'; prNumber = ${prNumber}; branch = 'feat/issue-718' })`,
      `$openPrs = @(@{ number = ${prNumber}; headRefOid = ${psString(headSha)}; headRefName = 'feat/issue-718' })`,
      `$result = Resume-ScriptedReviewStdoutDeliveryFromLifecycle -DeliveryKey ${psString(key)} -LifecycleStorePath ${psString(storePath)} -RepoRoot ${psString(repoRoot)} -Sessions $sessions -OpenPrs $openPrs -DryRun`,
      '$result | ConvertTo-Json -Compress',
    ].join('\n');
    const resumed = JSON.parse(runPwsh(resumeScript));
    expect(resumed.ok).toBe(true);
  });
});

describe('review delivery session unresolvable', () => {
  it('review delivery session unresolvable: ambiguous session resolution never marks delivered or sends', () => {
    const script = [
      `. ${psString(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'))}`,
      "$parsed = @{ ok = $true; gateVerdict = 'approved'; packVerdict = 'clean'; findings = @() }",
      `$result = Invoke-ScriptedReviewStdoutDelivery -RepoRoot ${psString(repoRoot)} -WrapperStdout ${psString(cleanStdout)} -ParsedStdout $parsed -PrNumber ${prNumber} -TargetSha ${psString(headSha)} -Sessions @(@{ id = 'a'; sessionId = 'a'; role = 'worker'; prNumber = ${prNumber} }, @{ id = 'b'; sessionId = 'b'; role = 'worker'; prNumber = ${prNumber} }) -OpenPrs @(@{ number = ${prNumber}; headRefOid = ${psString(headSha)}; headRefName = 'feat/issue-718' }) -DryRun`,
      '$result | ConvertTo-Json -Compress',
    ].join('\n');
    const result = JSON.parse(runPwsh(script));
    expect(result.ok).toBe(false);
    expect(result.escalated ?? result.reason).toBeTruthy();
  });
});

describe('review delivery telemetry non gating', () => {
  it('review delivery telemetry non gating: delivery path does not branch on telemetry outcome', () => {
    const postSubmit = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
      'utf8',
    );
    expect(postSubmit).toMatch(/Invoke-ScriptedReviewDeliveryBestEffortTelemetry/);
    expect(postSubmit).not.toMatch(/if\s*\(\s*\$telemetry/);
    expect(postSubmit).not.toMatch(/substitute/);
  });
});

describe('review delivery dispatch unknown', () => {
  it('review delivery dispatch unknown: bounded retry constant present and dispatch_unknown does not mark delivered', () => {
    const text = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
      'utf8',
    );
    expect(text).toMatch(/dispatch_unknown/);
    expect(text).toMatch(/MaxDispatchUnknownAttempts/);
    expect(text).toMatch(/terminalStatus = 'escalated'/);
  });
});

describe('review delivery journal register before send', () => {
  it('review delivery journal register before send: registers dispatch before journaled DeliveryId reuse', () => {
    const text = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
      'utf8',
    );
    expect(text).toMatch(/Register-WorkerMessageDispatch/);
    expect(text).toMatch(/-DeterministicDeliveryKey \$DeliveryKey/);
    const sendBlock = text.slice(text.indexOf('function Invoke-ScriptedReviewStdoutDeliverySend'));
    const registerIndex = sendBlock.indexOf('Register-WorkerMessageDispatch');
    const invokeSendIndex = sendBlock.indexOf('pwsh -NoProfile -File $journaledScript');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(invokeSendIndex).toBeGreaterThan(registerIndex);
  });
});

describe('review delivery session resolver inputs', () => {
  it('review delivery session resolver inputs: omitted Sessions/OpenPrs default to null for live fetch', () => {
    const text = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
      'utf8',
    );
    expect(text).toMatch(/\[object\[\]\]\$Sessions = \$null/);
    expect(text).toMatch(/\[object\[\]\]\$OpenPrs = \$null/);
    expect(text).toMatch(/if \(\$null -eq \$OpenPrs\)/);
    expect(text).toMatch(/if \(\$null -eq \$Sessions\)/);
  });
});

describe('review delivery journal durable path', () => {
  it('review delivery journal durable path: default resolves under wake supervisor state root', () => {
    const script = `
      . ${psString(path.join(repoRoot, 'scripts/lib/Record-WorkerMessageDispatch.ps1'))}
      $path = Get-WorkerMessageDispatchJournalPath
      if ($env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL) { Remove-Item Env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL }
      $path = Get-WorkerMessageDispatchJournalPath
      @{ path = $path; underTemp = $path.StartsWith([System.IO.Path]::GetTempPath()) } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.underTemp).toBe(false);
    expect(result.path).toContain('orchestrator-pack-wake-supervisor');
  });
});

describe('review delivery deterministic identity', () => {
  it('builds stable delivery id for same session and key', () => {
    const key = deliveryKey([{ id: 'x' }]);
    const left = buildDeterministicDeliveryId('session-1', key);
    const right = buildDeterministicDeliveryId('session-1', key);
    expect(left).toBe(right);
    expect(left).toContain('pack-send:det:');
  });
});

describe('review delivery daemon recovery demotion', () => {
  it('review delivery does not wait on daemon run recovery scripts', () => {
    const stdoutLib = readFileSync(
      path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
      'utf8',
    );
    expect(stdoutLib).not.toMatch(/review-run-recovery\.ps1/);
    expect(stdoutLib).not.toMatch(/review-stuck-run-reaper\.ps1/);
    expect(stdoutLib).not.toMatch(/Wait-ScriptedReviewSubmittedRun/);
  });
});

describe('review delivery AGENTS clause', () => {
  it('AGENTS.md documents silent skip on telemetry failure without substitute notifications', () => {
    const text = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    expect(text).toMatch(/Review delivery telemetry \(Issue #718\)/);
    expect(text).toMatch(/skip silently/);
    expect(text).toMatch(/substitute notifications/);
  });
});
