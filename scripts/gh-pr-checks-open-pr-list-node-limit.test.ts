import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, repoRoot } from './_test-pwsh-helpers.js';

const ghPrChecks = readFileSync(path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1'), 'utf8');
const fleetCache = readFileSync(path.join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1'), 'utf8');

describe('Invoke-GhOpenPrList query cost (node-limit regression)', () => {
  const openPrListBody = functionBody(ghPrChecks, 'Invoke-GhOpenPrList');
  const upstreamBody = functionBody(fleetCache, 'Invoke-GhFleetFetchOpenPrListUpstream');
  const prListLine = upstreamBody.split('\n').find((l) => l.includes('gh pr list'));

  it('issues a gh pr list query in the fleet upstream fetch helper', () => {
    expect(prListLine, 'gh pr list invocation not found').toBeTruthy();
  });

  it('requests baseRefName for handoff admission snapshots', () => {
    expect(prListLine).toMatch(/baseRefName/);
  });

  it('does not request the heavy commits connection in the list query', () => {
    expect(prListLine).not.toMatch(/commits/);
  });

  it('routes open-PR inventory through the fleet cache layer', () => {
    expect(openPrListBody).toMatch(/Invoke-GhFleetCachedOpenPrListRaw/);
    expect(openPrListBody).toMatch(/Add-GhPrHeadCommittedAtFromFleetMemo/);
  });

  it('still resolves head commit committed date per-PR via fleet memo helper', () => {
    expect(openPrListBody).toMatch(/Add-GhPrHeadCommittedAtFromFleetMemo/);
    expect(fleetCache).toMatch(/gh api[^\n]*commits\//);
  });
});

describe('Invoke-GhOpenPrListForNumbers query cost', () => {
  const body = functionBody(ghPrChecks, 'Invoke-GhOpenPrListForNumbers');
  const captureBody = functionBody(ghPrChecks, 'Invoke-GhPrViewStructuredCapture');

  it('scopes GitHub lookups to explicit PR numbers', () => {
    expect(body).toMatch(/Invoke-GhPrViewStructuredCapture/);
    expect(captureBody).toMatch(/'pr',\s*'view'/);
    expect(body).not.toMatch(/gh pr list/);
  });

  it('resolves head commit committed date per scoped PR via fleet memo', () => {
    expect(body).toMatch(/Add-GhPrHeadCommittedAtFromFleetMemo/);
  });

  it('parses scoped pr view JSON from stdout only without stderr merge (#566)', () => {
    expect(body).not.toMatch(/2>&1/);
    expect(body).toMatch(/Invoke-GhPrViewStructuredCapture/);
  });

  it('requests PR state and excludes closed or merged PRs', () => {
    expect(captureBody).toMatch(/--json[^\n]*state/);
    expect(body).toMatch(/state.*OPEN|OPEN.*state/);
  });
});
