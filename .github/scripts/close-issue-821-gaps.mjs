import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const abs = (file) => path.join(root, file);
const read = (file) => readFileSync(abs(file), 'utf8');
function write(file, content) {
  const normalized = String(content).replaceAll('\r\n', '\n');
  writeFileSync(abs(file), normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8');
}
function remove(file) {
  if (existsSync(abs(file))) rmSync(abs(file), { recursive: true, force: true });
}
function replaceOne(file, search, replacement) {
  const source = read(file);
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`${file}: replacement marker not found: ${search.slice(0, 100)}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`${file}: replacement marker is not unique: ${search.slice(0, 100)}`);
  }
  write(file, source.slice(0, index) + replacement + source.slice(index + search.length));
}
function replaceRange(file, startMarker, endMarker, replacement) {
  const source = read(file);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${file}: start marker missing: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${file}: end marker missing: ${endMarker}`);
  write(file, source.slice(0, start) + replacement + source.slice(end));
}

replaceOne(
  'docs/autonomous-gate-preflight.mjs',
  `export function loadAutonomousCapabilitiesInventory(inventoryPath, defaultRelativePath) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolved = inventoryPath ?? path.join(repoRoot, defaultRelativePath);
  return JSON.parse(readFileSync(resolved, 'utf8'));
}`,
  `export function loadAutonomousCapabilitiesInventory(inventoryPath, defaultRelativePath) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolved = inventoryPath ?? path.join(repoRoot, defaultRelativePath);
  const inventory = JSON.parse(readFileSync(resolved, 'utf8'));
  if (!inventory?.sharedCapabilitiesPath) return inventory;
  const sharedPath = path.join(repoRoot, String(inventory.sharedCapabilitiesPath));
  const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
  return mergeAutonomousCapabilitiesInventory(inventory, shared);
}`,
);

const boundaryTest = 'scripts/autonomous-orchestrator-boundary.test.ts';
replaceOne(
  boundaryTest,
  `import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, cpSync } from 'node:fs';`,
  `import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';`,
);
replaceOne(boundaryTest, 'AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION, TURN_VISIBLE_REAL_BINARY_ENV_VARS, ', 'AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION, ');
replaceOne(
  boundaryTest,
  `const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');`,
  `const boundaryLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
const spawnGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const reviewStartGateLibPath = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1');
const workerNudgeGateLibPath = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');

function evaluateSessionRoleCell(sessionId: string | null) {
    const literal = sessionId === null ? '$null' : psString(sessionId);
    const output = runPwsh(\`
      $prior = $env:AO_SESSION_ID
      try {
        if (\${literal} -eq $null) { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
        else { $env:AO_SESSION_ID = \${literal} }
        . \${psString(spawnGateLibPath)}
        . \${psString(reviewStartGateLibPath)}
        . \${psString(workerNudgeGateLibPath)}
        . \${psString(boundaryLibPath)}
        $review = Test-AutonomousRawReviewRunDenied -Argv @('review','run')
        $worker = Test-AutonomousRawWorkerSendDenied -Argv @('send','worker-1')
        $git = Test-AutonomousGitDenied -Argv @('branch','-m','blocked')
        [pscustomobject]@{
          spawn = [bool](Test-OrchestratorAutonomousSurfaceActiveForSpawnGate)
          review = [bool](Test-OrchestratorAutonomousSurfaceActive)
          boundary = [bool](Test-OrchestratorAutonomousSurfaceActiveForBoundary)
          reviewDenied = [bool]$review.denied
          reviewReason = [string]$review.reason
          workerDenied = [bool]$worker.denied
          workerReason = [string]$worker.reason
          gitDenied = [bool]$git.denied
          gitReason = [string]$git.reason
        } | ConvertTo-Json -Compress
      }
      finally {
        if ($prior) { $env:AO_SESSION_ID = $prior }
        else { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
      }
      exit 0
    \`);
    return JSON.parse(output.trim());
}`,
);
replaceRange(
  boundaryTest,
  `    it('exports stable boundary markers', () => {`,
  `    it('policy-aware spawn boundary allows default-on autonomous spawn', () => {`,
  `    it('exports the stable boundary marker', () => {
        expect(AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION).toBe('autonomous-orchestrator-boundary/v1');
    });
    it.each([
        ['orchestrator', 'orchestrator-session'],
        ['worker', 'worker-session'],
    ])('%s session activates all in-process autonomous predicates', (_role, sessionId) => {
        const result = evaluateSessionRoleCell(sessionId);
        expect(result.spawn).toBe(true);
        expect(result.review).toBe(true);
        expect(result.boundary).toBe(true);
        expect(result.reviewDenied).toBe(true);
        expect(result.reviewReason).toBe('autonomous_raw_review_run_denied');
        expect(result.workerDenied).toBe(true);
        expect(result.workerReason).toBe('autonomous_raw_worker_send_denied');
        expect(result.gitDenied).toBe(true);
        expect(result.gitReason).toBe('autonomous_mutating_git_denied');
    });
    it.each([
        ['review', null],
        ['operator manual shell', null],
        ['CI', null],
    ])('%s without AO_SESSION_ID remains outside the in-process gate', (_role, sessionId) => {
        const result = evaluateSessionRoleCell(sessionId);
        expect(result.spawn).toBe(false);
        expect(result.review).toBe(false);
        expect(result.boundary).toBe(false);
        expect(result.reviewDenied).toBe(false);
        expect(result.reviewReason).toBe('manual_surface');
        expect(result.workerDenied).toBe(false);
        expect(result.workerReason).toBe('manual_surface');
        expect(result.gitDenied).toBe(false);
        expect(result.gitReason).toBe('manual_surface');
    });
    it('uses AO_SESSION_ID presence rather than a magic value', () => {
        const result = evaluateSessionRoleCell('worker-any-nonempty-value');
        expect(result.spawn).toBe(true);
        expect(result.review).toBe(true);
        expect(result.boundary).toBe(true);
    });
    it('retains the claimed-review bypass reason', () => {
        const output = runPwsh(\`
          . \${psString(reviewStartGateLibPath)}
          $env:AO_SESSION_ID = 'orchestrator-session'
          $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
          (Test-AutonomousRawReviewRunDenied -Argv @('review','run')) | ConvertTo-Json -Compress
        \`);
        const result = JSON.parse(output.trim());
        expect(result.denied).toBe(false);
        expect(result.reason).toBe('claimed_bypass');
    });
    it('retires direct-command boundary wrappers', () => {
        for (const retired of [
            'scripts/ao',
            'scripts/git',
            'scripts/ao-autonomous-guard.ps1',
            'scripts/git-autonomous-guard.ps1',
        ]) {
            expect(existsSync(path.join(repoRoot, retired))).toBe(false);
        }
    });
`,
);
replaceRange(
  boundaryTest,
  `    it('example yaml documents out-of-band real binaries and git shim PATH', () => {`,
  `    describe('broken explicit ao pointer policy (Issue #495)', { timeout: 120000 }, () => {`,
  `    it('example yaml documents AO 0.10.2 in-process session gates', () => {
        const yaml = readFileSync(path.join(repoRoot, 'agent-orchestrator.yaml.example'), 'utf8');
        expect(yaml).not.toMatch(/^\\s*AO_REAL_BINARY:/m);
        expect(yaml).not.toMatch(/^\\s*GIT_REAL_BINARY:/m);
        expect(yaml).not.toMatch(/autonomous-real-binaries\\.json/);
        expect(yaml).not.toMatch(/scripts\\/ao \\+ scripts\\/git/);
        expect(yaml).toMatch(/AO_SESSION_ID/);
        expect(yaml).toMatch(/in-process gates/i);
    });
`,
);
replaceRange(
  boundaryTest,
  `    describe('broken explicit ao pointer policy (Issue #495)', { timeout: 120000 }, () => {`,
  `    it('resolves pack root from boundary lib without explicit PackRoot', () => {`,
  '',
);
replaceRange(
  boundaryTest,
  `    it('resolves pack root from boundary lib without explicit PackRoot', () => {`,
  `    it('allows coordinated agent-orchestrator.yaml.example edits for issue 324', () => {`,
  '',
);

const spawnWorktreeTest = 'scripts/autonomous-spawn-worktree-gate.test.ts';
replaceOne(spawnWorktreeTest, 'evaluateBoundaryEscapeSignal, ', '');
replaceOne(spawnWorktreeTest, `import { autonomousBashEnv } from './_test-git-fixture.js';\n`, '');
replaceRange(
  spawnWorktreeTest,
  `    it('boundary escape audit detects surface unset after bootstrap', () => {`,
  `    it('mjs git boundary honors spawn grant allow flag', () => {`,
  '',
);

const workerTest = 'scripts/worker-nudge-gate.test.ts';
replaceRange(
  workerTest,
  `    it('preflight fails closed when raw send capability is missing from live inventory', () => {`,
  `    it('adoption gate degrades when gated command missing', () => {`,
  `    it('preflight fails closed when the daemon session capability is missing', () => {
        const result = evaluatePreflight({
            loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
            atomicClaimPresent: true,
            liveCapabilities: [
                { id: 'autonomous-worker-nudge-gate', classification: 'gated' },
                { id: 'worker-nudge-claim-atomic', classification: 'gated' },
                { id: 'journaled-worker-send-gated', classification: 'gated' },
            ],
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('autonomous-session-id_missing');
    });
    it('preflight passes with the AO 0.10.2 in-process capability inventory', () => {
        const result = evaluatePreflight({
            loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
            atomicClaimPresent: true,
            liveCapabilities: [
                { id: 'autonomous-session-id', classification: 'gated' },
                { id: 'autonomous-worker-nudge-gate', classification: 'gated' },
                { id: 'worker-nudge-claim-atomic', classification: 'gated' },
                { id: 'journaled-worker-send-gated', classification: 'gated' },
            ],
        });
        expect(result.ok).toBe(true);
    });
`,
);

remove('scripts/autonomous-session-gates.test.ts');
remove('issue-821-final-pass-report.txt');
console.log('Closed the remaining Issue #821 test and inventory gaps.');
