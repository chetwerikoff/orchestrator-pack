import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-gpt-weekly-report.mjs');
const SCHEMA = 'flow-manager-long-running-child-terminal/v1';
const UNTIL = '2026-11-10T12:00:00Z';
// Producer vocabulary: the report recognizes only labels whose segments occur in turn production sources.
const PRODUCER_SOURCE = [
  'child_terminal_result_duplicate', 'child_turn_result_identity_mismatch', 'child_turn_state',
  'driver_error', 'terminated_by_sigterm', 'no_reply', 'dead_turn_page_evidence', 'fallback_cause',
  'shared_candidate_cause', 'completed_page_only', 'author_effect_pr_head_changed',
].map((label) => `export const L_${label} = '${label}';`).join('\n');
const PRIVATE_TOKEN = 'ghp_Ab12Cd34Ef56Gh78Ij90';

let base: string;
let repo: string;
let primary: string;
let extra: string;

function sh(cwd: string, args: string[], date?: string): string {
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = runProcessSync({ command: 'git', args, cwd, env, inheritParentEnv: true });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}${r.error ?? ''}`);
  return r.stdout;
}

function commitFile(path: string, content: string, message: string, date: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', message], date);
}

function mergePr(pr: number, branch: string, path: string, title: string, date: string, content = `${branch}\n`): void {
  sh(repo, ['checkout', '-q', '-b', branch, 'main']);
  commitFile(path, content, `work for ${branch}`, '2026-11-02T00:00:00Z');
  sh(repo, ['checkout', '-q', 'main']);
  sh(repo, ['merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${pr} from owner/${branch}`, '-m', title], date);
}

interface Env {
  run: string; attempt?: string; at: string; outcome: 'success' | 'incident';
  incident?: string; cause?: string; extraFields?: Record<string, unknown>;
}

function envelope(e: Env): string {
  return JSON.stringify({
    schema: SCHEMA,
    run_identity: e.run,
    attempt_identity: e.attempt ?? `${e.run}-a`,
    completion_mode: 'browser-turn-result-v1',
    handoff_receipt_path: '/private/receipt-handoff.json',
    launcher_started_at: e.at,
    handoff_committed_at: e.at,
    terminal_at: e.at,
    lifecycle_outcome: e.outcome,
    ...(e.incident !== undefined ? { incident: e.incident } : {}),
    delivery: 'landed',
    ...(e.cause !== undefined ? { turn_result_cause: e.cause } : {}),
    recovery_available: false,
    cwd: '/home/secret-user/private-worktree',
    conversation_locator: 'https://chatgpt.com/c/private-conversation',
    ...e.extraFields,
  }, null, 2);
}

function put(root: string, name: string, body: string): void {
  writeFileSync(join(root, name), body);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = runProcessSync({ command: process.execPath, args: [SCRIPT, ...args], inheritParentEnv: true });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      let digest = 'unreadable';
      try { digest = createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { /* unreadable fixture */ }
      lines.push(`${p} ${st.size} ${st.mtimeMs} ${st.mode} ${digest}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

function repoState(): string {
  return [
    sh(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    sh(repo, ['rev-parse', 'HEAD']),
    sh(repo, ['symbolic-ref', 'HEAD']),
    sh(repo, ['status', '--porcelain', '--untracked-files=all']),
  ].join('\n');
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'bgpt-weekly-'));
  repo = join(base, 'repo');
  primary = join(base, 'primary');
  extra = join(base, 'secret-root-name');
  mkdirSync(repo);
  mkdirSync(primary);
  mkdirSync(join(extra, 'nested'), { recursive: true });

  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.email', 'report@test.local']);
  sh(repo, ['config', 'user.name', 'weekly-report']);
  commitFile('README.md', 'base\n', 'initial', '2026-11-01T00:00:00Z');
  // Unrelated PR (merge commit).
  mergePr(101, 'docs-tweak', 'docs/a.md', 'Docs tweak', '2026-11-05T10:00:00Z');
  // Relevant PR (merge commit touching a turn production source).
  mergePr(102, 'turn-fix', 'scripts/chatgpt-browser-turn/ui-adapter.ts', 'Fix turn adapter', '2026-11-07T00:00:00Z', `${PRODUCER_SOURCE}\n`);
  // Direct commit without PR metadata.
  commitFile('notes.txt', 'n\n', 'chore: direct commit without pr', '2026-11-08T00:00:00Z');
  // Squash PR touching only a turn test file: not Browser-GPT production.
  commitFile('scripts/chatgpt-browser-turn/ui-adapter.test.ts', 't\n', 'test(turn): add cases (#104)', '2026-11-08T06:00:00Z');
  // Relevant squash PR (late in the window, after-window clipped by --until).
  // Squash PR whose subject carries credential- and home-path-shaped text.
  commitFile('docs/rotate.md', 'r\n', 'fix: rotate ghp_Zz99Yy88Xx77Ww66Vv55 for /home/alice/x (#106)', '2026-11-08T07:00:00Z');
  commitFile('scripts/flow-manager-long-running-child.ts', 'c\n', 'fix(child): settle late (#103)', '2026-11-09T20:00:00Z');
  // Backdated first-parent tip: date-pruned traversal (--since) would hide every in-window marker.
  commitFile('docs/late.md', 'l\n', 'chore: backdated tip (#105)', '2026-10-20T00:00:00Z');
  // Feature branch checked out, must never be used as the default branch.
  sh(repo, ['checkout', '-q', '-b', 'feature']);
  commitFile('scripts/chatgpt-browser-turn.ts', 'f\n', 'feat: feature only (#999)', '2026-11-09T21:00:00Z');
  sh(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  sh(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  // Envelopes around PR #102 (t = 2026-11-07T00:00Z).
  put(primary, 'e1-terminal.json', envelope({ run: 'r1', at: '2026-11-06T05:00:00Z', outcome: 'success', cause: 'completed_page_only' }));
  put(primary, 'e2-terminal.json', envelope({ run: 'r2', at: '2026-11-06T06:00:00Z', outcome: 'incident', incident: 'child_terminal_result_duplicate', cause: 'shared_candidate_cause' }));
  put(primary, 'e3-terminal.json', envelope({ run: 'r3', at: '2026-11-07T01:00:00Z', outcome: 'incident', incident: 'child_turn_result_identity_mismatch', cause: 'shared_candidate_cause' }));
  put(primary, 'e4-terminal.json', envelope({ run: 'r4', at: '2026-11-07T02:00:00Z', outcome: 'incident', incident: 'child_turn_state:driver_error', cause: 'terminated_by_sigterm' }));
  put(primary, 'e5-terminal.json', envelope({ run: 'r5', at: '2026-11-07T03:00:00Z', outcome: 'incident', incident: 'child_turn_state:driver_error', cause: 'Target closed at /home/secret-user' }));
  put(primary, 'e6-terminal.json', envelope({ run: 'r6', at: '2026-11-07T04:00:00Z', outcome: 'success', cause: 'author_effect_pr_head_changed' }));
  // 2026-11-08: missing incident reason, unusable cause -> unknown; usable cause fallback.
  put(primary, 'e7-terminal.json', envelope({ run: 'r7', at: '2026-11-08T10:00:00Z', outcome: 'incident', cause: 'page.goto: net::ERR https://chatgpt.com/g/private' }));
  put(extra, 'e8-terminal.json', envelope({ run: 'r8', at: '2026-11-08T11:00:00Z', outcome: 'incident', cause: 'fallback_cause' }));
  // Around PR #103 (t = 2026-11-09T20:00Z).
  put(primary, 'e9-terminal.json', envelope({ run: 'r9', at: '2026-11-09T10:00:00Z', outcome: 'success', cause: 'completed_page_only' }));
  put(extra, 'nested/e10-terminal.json', envelope({ run: 'r10', at: '2026-11-10T11:59:59.999Z', outcome: 'incident', incident: 'child_turn_state:no_reply', cause: 'dead_turn_page_evidence' }));
  put(primary, 'e11-terminal.json', envelope({ run: 'r11', at: UNTIL, outcome: 'incident', incident: 'after_until_excluded' }));
  // Credential-shaped incident and private result label are unrecognized -> unknown, never printed.
  put(primary, 'e15-terminal.json', envelope({ run: 'r15', at: '2026-11-04T12:00:00Z', outcome: 'incident', incident: PRIVATE_TOKEN, cause: 'alice_private_account' }));
  // Window start boundary (start = 2026-11-03T12:00Z).
  put(primary, 'e12-terminal.json', envelope({ run: 'r12', at: '2026-11-03T11:59:59Z', outcome: 'incident', incident: 'before_start_excluded' }));
  put(primary, 'e13-terminal.json', envelope({ run: 'r13', at: '2026-11-03T12:00:00Z', outcome: 'success' }));
  // Identical duplicate of e3 in the extra root counts once.
  put(extra, 'e3-copy-terminal.json', readFileSync(join(primary, 'e3-terminal.json'), 'utf8'));
  // Conflicting duplicate identity is excluded.
  put(primary, 'e14-terminal.json', envelope({ run: 'r14', at: '2026-11-08T12:00:00Z', outcome: 'incident', incident: 'conflict_a' }));
  put(extra, 'e14-terminal.json', envelope({ run: 'r14', at: '2026-11-08T13:00:00Z', outcome: 'incident', incident: 'conflict_b' }));
  // Skipped inputs.
  put(primary, 'bad-terminal.json', '{ not json');
  put(primary, 'old-terminal.json', JSON.stringify({ schema: 'flow-manager-long-running-child-terminal/v0', terminal_at: '2026-11-08T00:00:00Z' }));
  put(primary, 'noid-terminal.json', JSON.stringify({ schema: SCHEMA, run_identity: 'x', attempt_identity: 'y', terminal_at: 'not a date', lifecycle_outcome: 'success' }));
  put(primary, 'outcome-terminal.json', JSON.stringify({ schema: SCHEMA, run_identity: 'x2', attempt_identity: 'y2', terminal_at: '2026-11-08T00:00:00Z', lifecycle_outcome: 'maybe' }));
  put(primary, 'ignored-handoff.json', envelope({ run: 'rh', at: '2026-11-08T00:00:00Z', outcome: 'incident', incident: 'not_an_envelope_file' }));
  put(primary, 'locked-terminal.json', envelope({ run: 'rl', at: '2026-11-08T00:00:00Z', outcome: 'incident', incident: 'locked_unread' }));
  chmodSync(join(primary, 'locked-terminal.json'), 0o000);
});

afterAll(() => {
  try { chmodSync(join(primary, 'locked-terminal.json'), 0o600); } catch { /* already gone */ }
  rmSync(base, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('browser-gpt-weekly-report CLI', () => {
  it('documents options, time semantics and the selector in --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const token of ['--repo-root', '--days', '--until', '--envelope-root', '--primary-root', '--default-ref',
      'half-open', 'UTC', 'scripts/chatgpt-browser-turn/**', 'scripts/flow-manager-long-running-child.ts',
      'scripts/flow-manager-browser-gpt-long-run.ts', 'scripts/chatgpt-browser-turn.ts', 'Correlation only']) {
      expect(r.stdout).toContain(token);
    }
  });

  it('reports daily shares, causes, markers and before/after comparisons without mutating inputs', () => {
    const before = `${snapshot(primary)}\n${snapshot(extra)}\n${repoState()}`;
    const r = run(['--repo-root', repo, '--primary-root', primary, '--envelope-root', extra,
      '--envelope-root', join(base, 'missing-root'), '--until', UNTIL, '--days', '7']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = r.stdout;
    const after = `${snapshot(primary)}\n${snapshot(extra)}\n${repoState()}`;
    expect(after).toBe(before);

    expect(out).toContain('Window (UTC, half-open): [2026-11-03T12:00:00.000Z, 2026-11-10T12:00:00.000Z)');
    expect(out).toMatch(/Default branch: refs\/heads\/main @ [0-9a-f]{40} \(resolved from checkout metadata/u);
    expect(out).toContain('terminal attempts');
    expect(out).toContain('not successful sends');
    // Coverage.
    expect(out).toContain('extra #2: UNAVAILABLE');
    expect(out).toContain('primary (explicit --primary-root): ');
    expect(out).toContain('UNAVAILABLE');
    expect(out).toContain(`skipped files: unreadable ${isRoot ? 0 : 1}, malformed JSON 1, unsupported schema 1, invalid fields 2`);
    expect(out).toContain('duplicate files of an already-seen attempt: 2; conflicting attempt identities excluded: 1');
    expect(out).not.toContain('NO DATA');

    // Daily rows (zero-turn days and partial boundaries visible).
    expect(out).toContain('  2026-11-03 partial [12:00:00, 24:00:00): 0/1 incident 0.0%');
    expect(out).toContain('  2026-11-04: 1/1 incident 100.0%\n    causes: unknown=1\n');
    expect(out).toContain('  2026-11-05: 0/0 incident N/A\n');
    expect(out).toContain('  2026-11-06: 1/2 incident 50.0%\n    causes: child_terminal_result_duplicate=1\n');
    expect(out).toContain('  2026-11-07: 3/4 incident 75.0%\n    causes: child_turn_result_identity_mismatch=1, child_turn_state:driver_error=1, child_turn_state:driver_error|terminated_by_sigterm=1\n');
    expect(out).toContain('  2026-11-08: 2/2 incident 100.0%');
    expect(out).toContain('  2026-11-09: 0/1 incident 0.0%');
    expect(out).toContain('  2026-11-10 partial [00:00:00, 12:00:00): 1/1 incident 100.0%');
    expect(out).toContain('  window total: 8/12 incident 66.7%');

    // Cause keys: specific incident wins over a shared result cause; generic wrapper refinement and
    // fallbacks; successes never counted.
    const causes = out.split('Top incident causes')[1].split('Default-branch integrations')[0];
    expect(causes.trim().split('\n').slice(1).map((l) => l.trim())).toEqual([
      '2  unknown',
      '1  child_terminal_result_duplicate',
      '1  child_turn_result_identity_mismatch',
      '1  child_turn_state:driver_error',
      '1  child_turn_state:driver_error|terminated_by_sigterm',
      '1  child_turn_state:no_reply|dead_turn_page_evidence',
      '1  fallback_cause',
    ]);
    for (const absent of ['shared_candidate_cause', 'completed_page_only', 'author_effect_pr_head_changed',
      'conflict_a', 'conflict_b', 'not_an_envelope_file', 'after_until_excluded', 'before_start_excluded',
      'secret-user', 'private', 'Target closed', 'chatgpt.com', 'r10-a', 'locked_unread', PRIVATE_TOKEN,
      'alice', 'ghp_Zz99', 'secret-root-name', base]) {
      expect(out).not.toContain(absent);
    }

    // Markers: merge and squash PRs, unrelated ones included, feature branch never used.
    const markers = out.split('Default-branch integrations in window (first-parent):')[1].split('Browser-GPT merge comparisons')[0];
    expect(markers).toMatch(/2026-11-05T10:00:00\.000Z {2}[0-9a-f]{12} {2}PR #101 {2}\[other\] {2}Docs tweak/u);
    expect(markers).toMatch(/2026-11-07T00:00:00\.000Z {2}[0-9a-f]{12} {2}PR #102 {2}\[browser-gpt\] {2}Fix turn adapter/u);
    expect(markers).toMatch(/2026-11-08T00:00:00\.000Z {2}[0-9a-f]{12} {2}PR unknown {2}\[other\] {2}subject: chore: direct commit without pr/u);
    expect(markers).toMatch(/PR #104 {2}\[other\] {2}test\(turn\): add cases/u);
    expect(markers).toMatch(/2026-11-09T20:00:00\.000Z {2}[0-9a-f]{12} {2}PR #103 {2}\[browser-gpt\] {2}fix\(child\): settle late/u);
    expect(markers).toMatch(/PR #106 {2}\[other\] {2}fix: rotate \[redacted\] for \[redacted\]/u);
    expect(markers).not.toContain('PR #105');
    expect(markers).toContain('coverage limitation: 1 integration(s) without identifiable PR metadata');
    expect(out).not.toContain('#999');
    expect(markers.match(/PR #102/gu)).toHaveLength(1);

    // Comparisons only for Browser-GPT PRs.
    const cmp = out.split('Browser-GPT merge comparisons')[1];
    expect(cmp).not.toContain('PR #101');
    expect(cmp).not.toContain('PR #104');
    expect(cmp).toContain('correlation only, not causation');
    const pr102 = cmp.split('PR #102')[1].split('PR #103')[0];
    expect(pr102).toContain('before [2026-11-06T00:00:00.000Z, 2026-11-07T00:00:00.000Z): 1/2 incident 50.0%');
    expect(pr102).toContain('after  [2026-11-07T00:00:00.000Z, 2026-11-08T00:00:00.000Z): 3/4 incident 75.0%');
    expect(pr102).toContain('before causes: child_terminal_result_duplicate=1\n');
    expect(pr102).toContain('after causes: child_turn_result_identity_mismatch=1, child_turn_state:driver_error=1, child_turn_state:driver_error|terminated_by_sigterm=1\n');
    expect(pr102).toContain('newly observed causes (after>0, before=0; not necessarily novel defects): child_turn_result_identity_mismatch=1, child_turn_state:driver_error=1, child_turn_state:driver_error|terminated_by_sigterm=1\n');
    expect(pr102).not.toContain('INCOMPLETE');
    const pr103 = cmp.split('PR #103')[1];
    expect(pr103).toContain('before [2026-11-08T20:00:00.000Z, 2026-11-09T20:00:00.000Z): 0/1 incident 0.0%');
    expect(pr103).toContain('after  [2026-11-09T20:00:00.000Z, 2026-11-10T12:00:00.000Z) INCOMPLETE (clipped to --until): 1/1 incident 100.0%');
    expect(pr103).toContain('newly observed causes (after>0, before=0; not necessarily novel defects): child_turn_state:no_reply|dead_turn_page_evidence=1');
    expect(out).toContain('not attributed effects, ratings or verdicts');
  });

  it('reports no data, N/A shares and an incomplete after interval for an empty root', () => {
    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    const before = repoState();
    const r = run(['--repo-root', repo, '--primary-root', empty, '--until', '2026-11-10T01:00:00Z']);
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(repoState()).toBe(before);
    expect(readdirSync(empty)).toEqual([]);
    expect(out).toContain('NO DATA: no valid terminal envelopes');
    expect(out).toContain('  2026-11-04: 0/0 incident N/A (no data)');
    expect(out).toContain('window total: 0/0 incident N/A');
    const pr103 = out.split('Browser-GPT merge comparisons')[1].split('PR #103')[1];
    expect(pr103).toContain('after  [2026-11-09T20:00:00.000Z, 2026-11-10T01:00:00.000Z) INCOMPLETE (clipped to --until): 0/0 incident N/A');
    expect(pr103).toContain('comparison: N/A (a side has zero observations; no directional conclusion)');
    expect(pr103).toContain('newly observed causes: comparison unavailable (no before data)');
  });

  it('fails with actionable diagnostics on invalid arguments or unusable history', () => {
    const cases: Array<[string[], RegExp]> = [
      [['--until', UNTIL], /--repo-root <pack-checkout> is required/u],
      [['--repo-root', repo, '--days', '0'], /--days must be a whole number/u],
      [['--repo-root', repo, '--days', '1.5'], /--days must be a whole number/u],
      [['--repo-root', repo, '--days', 'Infinity'], /--days must be a whole number/u],
      [['--repo-root', repo, '--until', '2026-11-10 12:00'], /--until must be an ISO-8601 timestamp/u],
      [['--repo-root', repo, '--bogus'], /unknown argument "--bogus"/u],
      [['--repo-root', join(base, 'primary')], /is not a readable Git checkout/u],
    ];
    for (const [args, pattern] of cases) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(pattern);
      expect(r.stderr).not.toContain(base);
    }

    const bare = join(base, 'no-origin');
    mkdirSync(bare);
    sh(bare, ['init', '-q', '-b', 'trunk']);
    sh(bare, ['config', 'user.email', 'report@test.local']);
    sh(bare, ['config', 'user.name', 'weekly-report']);
    writeFileSync(join(bare, 'f'), 'x');
    sh(bare, ['add', '-A']);
    sh(bare, ['commit', '-q', '-m', 'only (#7)'], '2026-11-09T00:00:00Z');
    const noMeta = run(['--repo-root', bare, '--primary-root', join(base, 'empty'), '--until', UNTIL]);
    expect(noMeta.status).toBe(2);
    expect(noMeta.stderr).toMatch(/refs\/remotes\/origin\/HEAD is unset; pass --default-ref/u);
    const wrongRef = run(['--repo-root', bare, '--primary-root', join(base, 'empty'), '--until', UNTIL, '--default-ref', 'refs/heads/main']);
    expect(wrongRef.status).toBe(2);
    expect(wrongRef.stderr).toMatch(/does not resolve to a local commit/u);
    const explicit = run(['--repo-root', bare, '--primary-root', join(base, 'empty'), '--until', UNTIL, '--default-ref', 'refs/heads/trunk']);
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain('Default branch: refs/heads/trunk @');
    expect(explicit.stdout).toContain('(resolved from explicit --default-ref)');
    expect(explicit.stdout).toMatch(/PR #7 {2}\[other\] {2}only/u);
  });
});
