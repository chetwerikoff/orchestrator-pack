import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, repoRoot } from './_test-pwsh-helpers.js';

const ghPrChecks = readFileSync(path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1'), 'utf8');
const fleetCache = readFileSync(path.join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1'), 'utf8');

describe('Invoke-GhOpenPrList query cost (node-limit regression)', () => {
  const openPrListBody = functionBody(ghPrChecks, 'Invoke-GhOpenPrList');
  const upstreamBody = functionBody(fleetCache, 'Invoke-GhFleetFetchOpenPrListUpstream');
  const prListArguments = upstreamBody.match(/-Arguments\s+@\(([^)]*)\)/s)?.[0];

  it('issues a gh pr list query in the fleet upstream fetch helper', () => {
    expect(upstreamBody).toMatch(/Invoke-GhSignalJsonCommand/);
    expect(prListArguments, 'gh pr list argument vector not found').toBeTruthy();
    expect(prListArguments).toMatch(/'pr'\s*,\s*'list'/);
  });

  it('requests baseRefName for handoff admission snapshots', () => {
    expect(prListArguments).toMatch(/baseRefName/);
  });

  it('requests headRefName for fleet head-branch indexes', () => {
    expect(prListArguments).toMatch(/headRefName/);
  });

  it('does not request the heavy commits connection in the list query', () => {
    expect(prListArguments).not.toMatch(/commits/);
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

  it('scopes GitHub lookups to explicit PR numbers via fleet PR view cache', () => {
    expect(body).toMatch(/Invoke-GhFleetCachedPrView/);
    expect(body).not.toMatch(/gh pr list/);
  });

  it('resolves head commit committed date per scoped PR via fleet memo', () => {
    expect(body).toMatch(/Add-GhPrHeadCommittedAtFromFleetMemo/);
  });

  it('requests PR state and excludes closed or merged PRs', () => {
    expect(body).toMatch(/Invoke-GhFleetCachedPrView/);
    expect(body).toMatch(/state.*OPEN|OPEN.*state/);
  });
});

describe('Invoke-GhPrViewStructuredCapture review-start path (#566)', () => {
  const captureBody = functionBody(ghPrChecks, 'Invoke-GhPrViewStructuredCapture');

  it('captures scoped pr view with separated stdout/stderr', () => {
    expect(captureBody).toMatch(/'pr',\s*'view'/);
    expect(captureBody).toMatch(/RedirectStandardOutput/);
    expect(captureBody).toMatch(/RedirectStandardError/);
    expect(captureBody).not.toMatch(/2>&1/);
  });

  it('returns a terminal missing-binary capture instead of throwing', () => {
    expect(captureBody).toMatch(/New-GhPrViewMissingBinaryCapture/);
    expect(captureBody).toMatch(/Test-ReviewStartGhCommandResolvable/);
  });

  it('requests PR state in scoped review-start json fields', () => {
    expect(captureBody).toMatch(/--json[^\n]*state/);
  });
});
