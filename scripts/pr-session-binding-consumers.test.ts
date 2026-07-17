import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lookupBindingBySession,
  readPrSessionBindingCacheFile,
  resolvePrSessionBindingCachePath,
} from '../docs/pr-session-binding-cache.mjs';
import { resolveWorkerReportTrustedBinding } from '../docs/worker-report-store.mjs';
import { resolveWorkerStatusSessionBinding } from './lib/worker-status-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoSlug = 'chetwerikoff/orchestrator-pack';
const prNumber = 901;
const headSha = prNumber.toString(16).padStart(40, '0');
const tempDirs: string[] = [];

function cachePath(name = 'binding-cache.json') {
  const dir = mkdtempSync(path.join(tmpdir(), 'opk-857-consumer-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function worker(extra: Record<string, unknown> = {}) {
  return {
    id: 'opk-live',
    sessionId: 'opk-live',
    role: 'worker',
    status: 'working',
    repoSlug,
    issueNumber: 857,
    branch: 'issue-857-contract',
    prs: [`https://github.com/${repoSlug}/pull/${prNumber}`],
    ...extra,
  };
}

function openPr() {
  return {
    number: prNumber,
    headRefOid: headSha,
    headRefName: 'issue-857-contract',
    state: 'OPEN',
    repoSlug,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Issue #857 named consumers', () => {
  it('worker-status ignores retired daemon fields and backfills from prs[]', () => {
    const file = cachePath();
    const session = worker({ displayName: '999', prNumber: 999, pr: '#999' });
    const result = resolveWorkerStatusSessionBinding({
      session,
      sessions: [session],
      openPrs: [openPr()],
      repoSlug,
      headSha,
      bindingCachePath: file,
      nowMs: Date.parse('2026-07-17T12:00:00Z'),
      writeBackfill: true,
      osLiveness: { dead: false },
    }) as any;

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'opk-live',
      prNumber,
    });
    expect(result.bindingSource).toContain('live_prs');
    expect(lookupBindingBySession(
      readPrSessionBindingCacheFile(file),
      repoSlug,
      'opk-live',
    )?.prNumber).toBe(prNumber);
  });

  it('worker-report uses the same contract without a detail payload', () => {
    const file = cachePath('report-cache.json');
    const session = worker();
    const result = resolveWorkerReportTrustedBinding({
      session,
      openPrs: [openPr()],
      worktreeHeadSha: headSha,
      repoSlug,
      cachePath: file,
      nowMs: Date.parse('2026-07-17T12:00:00Z'),
    }) as any;

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'opk-live',
      prNumber,
    });
  });

  it('keeps one canonical binding-cache path locator', () => {
    expect(resolvePrSessionBindingCachePath({
      AO_PR_SESSION_BINDING_CACHE: '/tmp/explicit-cache.json',
      AO_REPORT_STATE_SEED_STATE: '/tmp/seed/state.json',
    })).toBe('/tmp/explicit-cache.json');
    expect(resolvePrSessionBindingCachePath({
      AO_REPORT_STATE_SEED_STATE: 'relative.json',
    })).toBe('pr-session-binding-cache.json');

    const bridge = readFileSync(
      path.join(repoRoot, 'scripts/lib/WorkerStatusStore.ps1'),
      'utf8',
    );
    expect(bridge).toContain("-Subcommand 'resolveBindingCachePath'");
    expect(bridge).not.toContain("'pr-session-binding-cache.json'");
  });
});
