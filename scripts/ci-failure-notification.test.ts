import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  appendAudit,
  assertTerminalAction,
  buildAdoptionArtifact,
  bindReactionEvent,
  compactRecords,
  decideCiFailureNotification,
  deriveEpisodeFromCiSource,
  episodeKeyDigest,
  evaluateHelperErrorEscalation,
  evaluateTargetApplySnapshot,
  markObservableSendFailure,
  scanFixtureSafety,
} from '../docs/ci-failure-notification.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');
const wrapperPath = path.join(repoRoot, 'scripts/ci-failure-notification.ps1');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

const episode = {
  repo: 'chetwerikoff/orchestrator-pack',
  prNumber: 283,
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redPeriod: 'suite-100-attempt-1',
  targetId: 'session-active-redacted',
  targetGeneration: 'generation-active-redacted',
};
const nextRedSameSha = { ...episode, redPeriod: 'suite-101-attempt-1' };
const supersededTarget = { ...episode, targetId: 'session-old-redacted', targetGeneration: 'generation-old-redacted' };
const newHead = { ...episode, headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', redPeriod: 'suite-200-attempt-1' };

function decision(input: any) {
  return decideCiFailureNotification({ episode, ...input });
}

function runWrapper(mode: string, input: unknown) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '-Mode', mode], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`wrapper failed ${result.status}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function tempStore() {
  return mkdtempSync(path.join(tmpdir(), 'ci-failure-notification-'));
}

describe('CI failure notification predicate (Issue #283)', () => {
  it('suppresses the reproduced duplicate when the ci-failed reaction already sent to the active target', () => {
    const event = fixture<any>('reaction-action-succeeded.json');
    const result = decision({ reactionEvents: [event] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('reaction_ci_failed_sent_to_active_target');
    expect(result.diagnostics.reaction_bind_status).toBe('matched');
    expect(result.bound_reaction_event_id).toBe('evt-redacted-ci-failed-1');
  });

  it('matches reaction-first events by episode identity, not wall-clock order', () => {
    const event = { ...fixture<any>('reaction-action-succeeded.json'), createdAt: '2026-06-13T00:00:00Z' };
    const result = decideCiFailureNotification({ episode, orchestratorObservedAt: '2026-06-13T00:00:30Z', reactionEvents: [event] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.diagnostics.reaction_bind_status).toBe('matched');
  });

  it('sends when the reaction is absent, the worker is idle, and no orchestrator token exists', () => {
    const result = decision({ reactionEvents: [], workerReports: [], intentTokens: [] });
    expect(result.terminal_action).toBe('SEND');
    expect(result.reason).toBe('no_suppressor');
  });

  it('does not let an earlier same-SHA red period suppress a later red period after green, even if green was missed', () => {
    const priorEvent = fixture<any>('reaction-action-succeeded.json');
    const priorToken = { episode, status: 'claimed' };
    const result = decideCiFailureNotification({ episode: nextRedSameSha, reactionEvents: [priorEvent], intentTokens: [priorToken] });
    expect(result.terminal_action).toBe('SEND');
    expect(result.diagnostics.reaction_bind_status).toBe('no-match');
    expect(result.intent_token_state).toBe('absent');
  });

  it('keeps per-check attempt churn and additional failures in the same aggregate red-period episode', () => {
    const ciA: any = fixture('canonical-ci-red.json');
    const ciB = { ...ciA, requiredChecks: [...ciA.requiredChecks, { name: 'matrix leg 2', conclusion: 'failure', attempt: 2 }] };
    const epA = deriveEpisodeFromCiSource({ repo: episode.repo, prNumber: episode.prNumber, headSha: episode.headSha, activeTarget: episode, ciSource: ciA });
    const epB = deriveEpisodeFromCiSource({ repo: episode.repo, prNumber: episode.prNumber, headSha: episode.headSha, activeTarget: episode, ciSource: ciB });
    expect(epA).toEqual(epB);
  });

  it('does not suppress on a superseded session reaction or intent token when the active target rotated', () => {
    const event = { ...fixture<any>('reaction-action-succeeded.json'), episode: supersededTarget };
    const result = decision({ reactionEvents: [event], intentTokens: [{ episode: supersededTarget, status: 'claimed' }] });
    expect(result.terminal_action).toBe('SEND');
    expect(result.diagnostics.reaction_bind_status).toBe('no-match');
    expect(result.intent_token_state).toBe('absent');
  });

  it('revalidates target generation before applying a stale decision', () => {
    const staleDecision = decision({ reactionEvents: [fixture<any>('reaction-action-succeeded.json')] });
    const apply = evaluateTargetApplySnapshot({ decision: staleDecision, snapshotTargetGeneration: episode.targetGeneration, currentTargetGeneration: 'generation-new-redacted' });
    expect(apply).toMatchObject({ apply: false, reason: 'target_rotated_redecide_required', terminal_action: 'SUPPRESS' });
  });

  it('suppresses explicit fixing_ci only when it binds to the full episode identity', () => {
    expect(decision({ workerReports: [{ state: 'fixing_ci', episode }] }).terminal_action).toBe('SUPPRESS');
    expect(decision({ workerReports: [{ state: 'fixing_ci', episode: nextRedSameSha }] }).terminal_action).toBe('SEND');
    expect(decision({ workerReports: [{ state: 'fixing_ci', episode: supersededTarget }] }).terminal_action).toBe('SEND');
    expect(decision({ workerReports: [{ state: 'addressing_reviews', episode }] }).terminal_action).toBe('SEND');
  });

  it('treats a new head SHA as a fresh episode with no inherited suppressors', () => {
    const priorEvent = fixture<any>('reaction-action-succeeded.json');
    const result = decideCiFailureNotification({ episode: newHead, reactionEvents: [priorEvent], intentTokens: [{ episode, status: 'claimed' }] });
    expect(result.terminal_action).toBe('SEND');
  });

  it('keeps cross-PR / reopened-branch collisions distinct even on the same SHA and check set', () => {
    const otherPr = { ...episode, prNumber: 284 };
    const result = decideCiFailureNotification({ episode: otherPr, intentTokens: [{ episode, status: 'claimed' }], reactionEvents: [fixture<any>('reaction-action-succeeded.json')] });
    expect(result.terminal_action).toBe('SEND');
  });

  it('treats stale or malformed reaction events as diagnostics, not terminal actions', () => {
    const malformed = { id: 'evt-malformed', type: 'reaction.action_succeeded', reactionKey: 'ci-failed', episode: { repo: episode.repo } };
    const stale = { ...fixture<any>('reaction-action-succeeded.json'), episode: { ...episode, headSha: 'cccccccccccccccccccccccccccccccccccccccc' } };
    const unbindable = decision({ reactionEvents: [malformed] });
    const noMatch = decision({ reactionEvents: [stale] });
    expect(unbindable.terminal_action).toBe('SEND');
    expect(unbindable.diagnostics.reaction_bind_status).toBe('unbindable');
    expect(noMatch.terminal_action).toBe('SEND');
    expect(noMatch.diagnostics.reaction_bind_status).toBe('no-match');
  });

  it('has a bindable capture-backed redacted reaction event fixture and safe fixture corpus', () => {
    const event = fixture<any>('reaction-action-succeeded.json');
    expect(bindReactionEvent(episode, [event]).status).toBe('matched');
    expect(scanFixtureSafety(event)).toEqual({ ok: true, findings: [] });
    expect(scanFixtureSafety(fixture('canonical-ci-red.json'))).toEqual({ ok: true, findings: [] });
  });

  it('does not let transient fetch failure manufacture a new episode or flip a recorded token decision', () => {
    const token = { episode, status: 'claimed' };
    const result = decision({ ciSource: { error: 'Failed to fetch CI checks' }, intentTokens: [token] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('orchestrator_intent_token_present');
  });

  it('safe-suppresses on canonical CI source disagreement rather than silently flipping verdict', () => {
    const result = decision({ ciSourceEquivalence: { disagreement: true, canonical: 'ao-scm-tracker', other: 'gh-pr-checks' } });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.diagnostics.error_kind).toBe('ci_source_disagreement');
  });

  it('emits an audit line with closed terminal_action enum and separate diagnostics for every decision', () => {
    const startedAt = Date.now();
    const result = decision({ reactionEvents: [{ id: 'bad', type: 'reaction.action_succeeded', reactionKey: 'ci-failed', episode: { repo: 'x' } }] });
    expect(['SEND', 'SUPPRESS']).toContain(result.audit.terminal_action);
    expect(result.audit.terminal_action).not.toBe('NO-MATCH');
    expect((result.audit.diagnostic as any).reaction_bind_status).toBe('unbindable');
    expect(result.audit.intent_token_state).toBe('absent');
    const emittedAt = Date.parse(result.audit.emitted_at_utc);
    expect(emittedAt).toBeGreaterThanOrEqual(startedAt);
    expect(emittedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('rejects terminal values outside SEND | SUPPRESS', () => {
    expect(() => assertTerminalAction('NO-MATCH')).toThrow(/invalid terminal_action/);
    expect(() => assertTerminalAction('error-suppress')).toThrow(/invalid terminal_action/);
  });

  it('writes decision audit records and builds a redacted adoption artifact that pins helper identity', () => {
    const dir = tempStore();
    try {
      const result = decision({ reactionEvents: [fixture('reaction-action-succeeded.json')] });
      const written = appendAudit({ storeDir: dir, audit: result.audit }) as any;
      expect(written.ok).toBe(true);
      expect(existsSync(written.path)).toBe(true);
      const artifact = buildAdoptionArtifact({
        ruleText: 'CI FAILURE DISCIPLINE redacted block',
        repoIdentity: 'chetwerikoff/orchestrator-pack',
        gitSha: 'dddddddddddddddddddddddddddddddddddddddd',
        wrapperPath,
        helperContent: readFileSync(path.join(repoRoot, 'docs/ci-failure-notification.mjs'), 'utf8'),
        dryRunVerdict: result,
      }) as any;
      expect(artifact).toMatchObject({ schema: 'ci-failure-notification.adoption-artifact.v1', wrapperIdentity: 'ci-failure-notification.ps1', dryRunVerdict: 'SUPPRESS' });
      expect(artifact.repoRootFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact).not.toHaveProperty('repoRoot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalates repeated helper errors operator-visibly while preserving safe SUPPRESS action', () => {
    expect(evaluateHelperErrorEscalation({ consecutiveErrors: 1 }).operator_visible).toBe(false);
    const result = evaluateHelperErrorEscalation({ consecutiveErrors: 3 });
    expect(result).toMatchObject({ terminal_action: 'SUPPRESS', operator_visible: true });
  });

  it('compacts by exact episode digest and closure triggers without dropping active target in-flight records', () => {
    const oldTime = '2026-06-01T00:00:00Z';
    const digest = episodeKeyDigest(episode);
    const activeDigest = episodeKeyDigest(nextRedSameSha);
    const result = compactRecords({
      nowMs: Date.parse('2026-06-13T00:00:00Z'),
      minRetentionMs: 24 * 60 * 60 * 1000,
      closures: [
        { digest, trigger: 'aggregate_green' },
        { digest: activeDigest, trigger: 'new_head_supersession' },
      ],
      records: [
        { digest, claimedAtUtc: oldTime, episode },
        { digest: activeDigest, claimedAtUtc: oldTime, episode: nextRedSameSha, activeTargetInFlight: true },
      ],
    });
    expect(result.removed).toEqual([{ digest, trigger: 'aggregate_green' }]);
    expect(result.retained).toHaveLength(1);
  });
});

describe('tracked PowerShell wrapper and token store', () => {
  it('obeys the helper verdict through the tracked wrapper', () => {
    const result = runWrapper('decide', { episode, reactionEvents: [fixture('reaction-action-succeeded.json')] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('reaction_ci_failed_sent_to_active_target');
  });

  it('safe-suppresses instead of crashing when the tracked helper is missing', () => {
    const dir = tempStore();
    try {
      const scriptsDir = path.join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const isolatedWrapper = path.join(scriptsDir, 'ci-failure-notification.ps1');
      copyFileSync(wrapperPath, isolatedWrapper);
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', isolatedWrapper, '-Mode', 'decide'], {
        cwd: dir,
        input: JSON.stringify({ episode }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ terminal_action: 'SUPPRESS', reason: 'wrapper_error', diagnostic: { error_kind: 'helper_error' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically claims exactly one intent token across concurrent wrapper calls', () => {
    const dir = tempStore();
    try {
      const script = `
        $wrapper = '${wrapperPath.replaceAll("'", "''")}'
        $payload = @{ storeDir='${dir.replaceAll("'", "''")}'; episode = @{
          repo='${episode.repo}'; prNumber=${episode.prNumber}; headSha='${episode.headSha}'; redPeriod='${episode.redPeriod}'; targetId='${episode.targetId}'; targetGeneration='${episode.targetGeneration}'
        }} | ConvertTo-Json -Compress
        $jobs = 1..2 | ForEach-Object { Start-Job -ArgumentList $wrapper,$payload -ScriptBlock { param($wrapper,$payload) $payload | pwsh -NoProfile -ExecutionPolicy Bypass -File $wrapper -Mode claim } }
        $rows = $jobs | Receive-Job -Wait -AutoRemoveJob | ForEach-Object { $_ | ConvertFrom-Json }
        $rows | ConvertTo-Json -Compress -Depth 10
      `;
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: repoRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
      const rows = JSON.parse(result.stdout.trim());
      expect(rows.filter((r: any) => r.claimed)).toHaveLength(1);
      expect(rows.filter((r: any) => !r.claimed)).toHaveLength(1);
      expect(rows.find((r: any) => !r.claimed).terminal_action).toBe('SUPPRESS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses at-most-once crash semantics but releases the token on an observable send failure', () => {
    const dir = tempStore();
    try {
      const claim = runWrapper('claim', { storeDir: dir, episode });
      expect(claim.claimed).toBe(true);
      const afterCrash = runWrapper('claim', { storeDir: dir, episode });
      expect(afterCrash).toMatchObject({ claimed: false, terminal_action: 'SUPPRESS' });
      const released = markObservableSendFailure({ storeDir: dir, episode, mode: 'release' });
      expect(released).toMatchObject({ terminal_action: 'SEND', released: true });
      const retry = runWrapper('claim', { storeDir: dir, episode });
      expect(retry.claimed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
