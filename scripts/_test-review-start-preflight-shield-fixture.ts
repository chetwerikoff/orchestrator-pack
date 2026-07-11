import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { functionBody, psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const shieldHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartPreflightShield.ps1');
const ghPrChecksPath = path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1');
const snapshotPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const fakeGhPath = path.join(
  repoRoot,
  'scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1',
);

const stableHead = '31fc8c6143c23e6db1b47fa8525aced110e2f84e';
const driftHeadB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function runScopedPreflight(scriptBody: string, env: Record<string, string> = {}) {
  const script = `
    . ${psString(shieldHelperPath)}
  ${scriptBody}
  `;
  return JSON.parse(runPwsh(script, env));
}

function missingGhPath(prefix: string) {
  const missingRoot = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(missingRoot, { recursive: true, force: true });
  return path.join(missingRoot, 'gh.ps1');
}

function listShieldAuditRecords(auditRoot: string) {
  const dir = path.join(auditRoot, 'preflight-shield');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
  } catch {
    return [];
  }
}


export {
  shieldHelperPath,
  ghPrChecksPath,
  snapshotPath,
  claimHelperPath,
  fakeGhPath,
  stableHead,
  driftHeadB,
  runScopedPreflight,
  missingGhPath,
  listShieldAuditRecords,
};
