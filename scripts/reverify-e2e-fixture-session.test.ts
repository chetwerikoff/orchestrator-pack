import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  claimOrSpawnFixtureHolder,
  isDedicatedFixtureHolderBranch,
  listAoSessionRecordsFromOutputs,
  parseAoSessionLsText,
  pickDedicatedFixtureHolderSession,
  readResolvedFixtureHolderClaim,
  resolveAoFixtureSessionId,
} from './lib/reverify-e2e-fixture-session.js';

const packRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const aoAvailable = spawnSync('which', ['ao'], { encoding: 'utf8' }).status === 0;

describe('reverify e2e fixture session resolution', () => {
  it('recognizes dedicated fixture-holder branch names', () => {
    expect(isDedicatedFixtureHolderBranch('session/opk-175')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/opk-176-reverify-e2e-holder')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/opk-178-reverify-e2e-holder-clean')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/issue-376')).toBe(false);
    expect(isDedicatedFixtureHolderBranch('fix/reverify-ci-fixture-holder')).toBe(false);
  });

  it('parses real piped ao session ls output without TTY indentation', () => {
    if (aoAvailable) {
      const listed = spawnSync('ao', ['session', 'ls'], {
        cwd: packRoot,
        encoding: 'utf8',
      });
      expect(listed.status).toBe(0);

      const parsed = parseAoSessionLsText(listed.stdout ?? '');
      const legacyRegexCount = (listed.stdout ?? '')
        .split('\n')
        .map((line) => line.match(/^\s+(opk-\S+)/)?.[1])
        .filter(Boolean).length;
      expect(parsed.length).toBeGreaterThanOrEqual(legacyRegexCount);
    }

    const sample = [
      'orchestrator-pack:',
      '  (no active sessions)',
      '',
      'opk-173:',
      '  (no active sessions)',
      'opk-176  (-)  session/opk-176  [active]',
    ].join('\n');
    const sampleParsed = parseAoSessionLsText(sample);
    const sampleLegacy = sample
      .split('\n')
      .map((line) => line.match(/^\s+(opk-\S+)/)?.[1])
      .filter(Boolean).length;
    expect(sampleParsed.map((session) => session.id)).toContain('opk-176');
    expect(sampleParsed.length).toBeGreaterThan(sampleLegacy);
  });

  it('prefers ao session ls --json when available', () => {
    const pipedSample = [
      'orchestrator-pack:',
      '  (no active sessions)',
      '',
      'opk-173:',
      '  (no active sessions)',
      'opk-176  (-)  session/opk-176  [active]',
    ].join('\n');
    const jsonSample = JSON.stringify({
      data: [{ id: 'opk-176', branch: 'session/opk-176', pr: null }],
    });

    const listing = listAoSessionRecordsFromOutputs({
      jsonStdout: jsonSample,
      textStdout: pipedSample,
    });
    expect(listing.source).toBe('json');
    expect(listing.records[0]?.id).toBe('opk-176');

    const fallback = listAoSessionRecordsFromOutputs({
      jsonStdout: 'not-json',
      textStdout: pipedSample,
    });
    expect(fallback.source).toBe('text');
    expect(fallback.records.map((session) => session.id)).toContain('opk-176');

    if (!aoAvailable) {
      return;
    }

    const jsonListed = spawnSync('ao', ['session', 'ls', '--json'], {
      cwd: packRoot,
      encoding: 'utf8',
    });
    const textListed = spawnSync('ao', ['session', 'ls'], {
      cwd: packRoot,
      encoding: 'utf8',
    });
    expect(jsonListed.status).toBe(0);
    expect(textListed.status).toBe(0);
  });

  it('does not spawn when only text listing is available without a dedicated holder', () => {
    let spawnCount = 0;
    const listing = listAoSessionRecordsFromOutputs({
      jsonStdout: 'not-json',
      textStdout: 'opk-173:\n  (no active sessions)\n',
    });
    expect(listing.source).toBe('text');

    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: listing.records,
      sessionListingSource: listing.source,
      allowSpawn: true,
      spawnSession: () => {
        spawnCount += 1;
        return 'opk-should-not-run';
      },
    });

    expect(resolved).toBeNull();
    expect(spawnCount).toBe(0);
  });

  it('prefers session/opk-* fixture holders over feat/opk-*-reverify-e2e-holder branches', () => {
    const picked = pickDedicatedFixtureHolderSession([
      { id: 'opk-173', branch: 'feat/issue-376' },
      { id: 'opk-176', branch: 'feat/opk-176-reverify-e2e-holder' },
      { id: 'opk-175', branch: 'session/opk-175' },
    ]);
    expect(picked).toBe('opk-175');
  });

  it('prefers dedicated fixture holder before the first arbitrary worker', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: [
        { id: 'opk-172', branch: 'feat/402' },
        { id: 'opk-173', branch: 'feat/issue-376' },
        { id: 'opk-175', branch: 'session/opk-175' },
      ],
      allowSpawn: false,
      spawnSession: () => null,
    });
    expect(resolved).toBe('opk-175');
  });

  it('honors OPK_REVERIFY_E2E_SESSION over dedicated fixture holders', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: 'opk-173',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: [
        { id: 'opk-173', branch: 'feat/issue-376' },
        { id: 'opk-175', branch: 'session/opk-175' },
      ],
      allowSpawn: false,
      spawnSession: () => null,
    });
    expect(resolved).toBe('opk-173');
  });

  it('does not hijack an arbitrary worker when no dedicated holder exists', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: [
        { id: 'opk-172', branch: 'feat/402', pr: null },
        { id: 'opk-173', branch: 'feat/issue-376', pr: 'https://github.com/example/pull/1' },
      ],
      allowSpawn: false,
      spawnSession: () => 'opk-should-not-run',
    });
    expect(resolved).toBeNull();
  });

  it('refuses a real-PR-owning dedicated-looking session', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: [
        {
          id: 'opk-175',
          branch: 'session/opk-175',
          pr: 'https://github.com/example/pull/99',
        },
      ],
      allowSpawn: false,
      spawnSession: () => null,
    });
    expect(resolved).toBeNull();
  });

  it('spawns an explicit fixture holder when none is live and spawn is allowed', () => {
    let spawnCount = 0;
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions: [{ id: 'opk-172', branch: 'feat/402' }],
      sessionListingSource: 'json',
      allowSpawn: true,
      spawnSession: () => {
        spawnCount += 1;
        return 'opk-spawned-holder';
      },
    });
    expect(resolved).toBe('opk-spawned-holder');
    expect(spawnCount).toBe(1);
  });

  it('reuses an existing holder and spawns nothing on a second resolution', () => {
    let spawnCount = 0;
    const knownSessions = [{ id: 'opk-175', branch: 'session/opk-175' }];
    const resolveOnce = () => resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessions,
      sessionListingSource: 'json',
      allowSpawn: true,
      spawnSession: () => {
        spawnCount += 1;
        return 'opk-should-not-run';
      },
    });

    expect(resolveOnce()).toBe('opk-175');
    expect(resolveOnce()).toBe('opk-175');
    expect(spawnCount).toBe(0);
  });

  it('does not treat a pending timestamp claim as a resolved session id', () => {
    const claimDir = mkdtempSync(path.join(os.tmpdir(), 'reverify-claim-pending-'));
    const claimPath = path.join(claimDir, 'fixture-holder.claim');
    writeFileSync(claimPath, '1782150475225\n', 'utf8');

    try {
      expect(readResolvedFixtureHolderClaim(claimPath)).toBeNull();
      const waiter = claimOrSpawnFixtureHolder({
        claimPath,
        knownSessions: [],
        spawnSession: () => 'opk-should-not-run',
        now: () => 1_782_150_475_300,
        sleepMs: () => {},
      });
      expect(waiter).toBeNull();
    } finally {
      rmSync(claimDir, { recursive: true, force: true });
    }
  });

  it('waits for a resolved claim during slow spawn and converges on one holder', () => {
    const claimDir = mkdtempSync(path.join(os.tmpdir(), 'reverify-claim-slow-'));
    const claimPath = path.join(claimDir, 'fixture-holder.claim');
    writeFileSync(claimPath, '5000\n', 'utf8');
    let loopCount = 0;

    try {
      const waiter = claimOrSpawnFixtureHolder({
        claimPath,
        knownSessions: [],
        spawnSession: () => 'opk-should-not-run',
        now: () => 5_100,
        sleepMs: () => {
          loopCount += 1;
          if (loopCount === 2) {
            writeFileSync(claimPath, 'opk-winner\n', 'utf8');
          }
        },
      });

      expect(waiter).toBe('opk-winner');
      expect(waiter).toMatch(/^opk-/);
    } finally {
      rmSync(claimDir, { recursive: true, force: true });
    }
  });

  it('claim lock allows only one spawn under concurrent claim', () => {
    const claimDir = mkdtempSync(path.join(os.tmpdir(), 'reverify-claim-'));
    const claimPath = path.join(claimDir, 'fixture-holder.claim');
    let spawnCount = 0;

    try {
      const first = claimOrSpawnFixtureHolder({
        claimPath,
        knownSessions: [],
        spawnSession: () => {
          spawnCount += 1;
          return 'opk-claimed';
        },
        now: () => 1_000,
        sleepMs: () => {},
      });
      const second = claimOrSpawnFixtureHolder({
        claimPath,
        knownSessions: [{ id: 'opk-claimed', branch: 'session/opk-claimed' }],
        spawnSession: () => {
          spawnCount += 1;
          return 'opk-should-not-run';
        },
        now: () => 1_010,
        sleepMs: () => {},
      });

      expect(first).toBe('opk-claimed');
      expect(second).toBe('opk-claimed');
      expect(spawnCount).toBe(1);
    } finally {
      if (existsSync(claimPath)) {
        rmSync(claimPath, { force: true });
      }
      rmSync(claimDir, { recursive: true, force: true });
    }
  });
});
