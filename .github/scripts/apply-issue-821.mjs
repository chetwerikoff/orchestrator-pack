import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const rel = (value) => value.replaceAll('\\', '/');
const abs = (value) => path.join(root, value);

function read(file) {
  return readFileSync(abs(file), 'utf8');
}

function write(file, content) {
  const normalized = content.replaceAll('\r\n', '\n');
  writeFileSync(abs(file), normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8');
}

function remove(file) {
  if (existsSync(abs(file))) rmSync(abs(file), { force: true, recursive: true });
}

function replaceExactly(file, search, replacement, expected = 1) {
  const source = read(file);
  let count = 0;
  const updated = source.replace(search, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count !== expected) {
    throw new Error(`${file}: expected ${expected} replacement(s), got ${count}`);
  }
  write(file, updated);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(rel);
}

function isHistorical(file) {
  return file.startsWith('docs/issues_drafts/') || file === 'docs/migration_notes.md';
}

const deletedFiles = [
  'scripts/ao',
  'scripts/git',
  'scripts/ao-autonomous-guard.ps1',
  'scripts/git-autonomous-guard.ps1',
  'scripts/git-real-binary',
  'scripts/_invoke-system-git.sh',
  'scripts/_resolve-system-git.sh',
  'scripts/autonomous-orchestrator-surface-bootstrap.sh',
  'scripts/autonomous-bash-env.sh',
  'docs/autonomous-real-binaries.example.json',
  'scripts/invoke-orchestrator-claimed-review-run.ps1',
  'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
  'scripts/check-worker-nudge-gate-adoption.ps1',
  'scripts/autonomous-orchestrator-interposer.test.ts',
  'scripts/_test-interposer-pack-fixture.ts',
];
for (const file of deletedFiles) remove(file);

// The AO 0.10.2 daemon exports AO_SESSION_ID to in-process orchestrator and worker turns.
for (const file of trackedFiles()) {
  if (isHistorical(file) || !existsSync(abs(file))) continue;
  const buffer = readFileSync(abs(file));
  if (buffer.includes(0)) continue;
  const source = buffer.toString('utf8');
  if (source.includes('AO_AUTONOMOUS_ORCHESTRATOR_SURFACE')) {
    write(file, source.replaceAll('AO_AUTONOMOUS_ORCHESTRATOR_SURFACE', 'AO_SESSION_ID'));
  }
}

for (const file of [
  'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1',
  'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1',
]) {
  replaceExactly(
    file,
    /return \[string\]\$env:AO_SESSION_ID -eq '1'/g,
    "return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)",
  );
}

replaceExactly(
  'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1',
  /\nfunction Test-IsPackAoShimPath \{[\s\S]*?\n\}\s*$/,
  '\n',
);

const boundaryFile = 'scripts/lib/Orchestrator-AutonomousBoundary.ps1';
const boundarySource = read(boundaryFile);
const boundaryTailMarker = 'function Get-LinuxParentProcessId {';
const boundaryTailIndex = boundarySource.indexOf(boundaryTailMarker);
if (boundaryTailIndex < 0) throw new Error(`${boundaryFile}: tail marker missing`);
let boundaryTail = boundarySource.slice(boundaryTailIndex);
boundaryTail = boundaryTail.replace(
  /\nfunction Test-ProcessCommandLineIsInvokeOrchestratorClaimedReviewRun \{[\s\S]*?\n\}\n/,
  '\n',
);
boundaryTail = boundaryTail.replace(
  /\n\s*if \(Test-ProcessCommandLineIsInvokeOrchestratorClaimedReviewRun -CommandLine \$cmd\) \{\n\s*return 'claimed_review_run'\n\s*\}\n/,
  '\n',
);
const boundaryHeader = `#requires -Version 5.1
<#
  In-process autonomous spawn/git policy helpers (Issues #324/#821).
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ReviewWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-WorkerRecoveryGate.ps1')

$Script:AutonomousBoundaryExitCode = 93
$Script:TurnVisibleRealBinaryEnvVars = @('AO_REAL_BINARY', 'GIT_REAL_BINARY')
$Script:SanctionedGitPreflightPatterns = @(
    'reviewer-workspace-preflight.ps1',
    'orchestrator-worktree-preflight.ps1'
)
$Script:WorkerRecoveryParentPattern = 'invoke-worker-recovery.ps1'
$Script:SanctionedGitParentPatterns = @($Script:SanctionedGitPreflightPatterns)
$Script:SanctionedGitParentMaxDepth = 2

function Get-PackRootFromBoundaryLib {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
}

function Test-OrchestratorAutonomousSurfaceActiveForBoundary {
    return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)
}

function Resolve-RealAoExecutable {
    param([string]$PackRoot = '')

    $command = Get-Command ao -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return 'ao'
}

function Resolve-SystemGitExecutable {
    param([string]$PackRoot = '')

    foreach ($candidate in @('/usr/bin/git', '/bin/git', '/usr/local/bin/git')) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    $command = Get-Command git -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return 'git'
}

function Resolve-RealGitExecutable {
    return Resolve-SystemGitExecutable
}

function Test-TurnVisibleRealBinaryBypassPresent {
    foreach ($name in $Script:TurnVisibleRealBinaryEnvVars) {
        if ([Environment]::GetEnvironmentVariable($name)) { return $true }
    }
    return $false
}

function Test-IsKnownSystemGitBinaryPath {
    param([string]$CandidatePath)

    if (-not $CandidatePath) { return $false }
    $leaf = Split-Path -Leaf $CandidatePath
    if ($leaf -ne 'git') { return $false }
    $normalized = ($CandidatePath -replace '\\\\', '/')
    return $normalized -match '^(?i)(/usr/bin/|/bin/|/usr/local/bin/)'
}

`;
write(boundaryFile, boundaryHeader + boundaryTail);

const spawnWorktreeFile = 'scripts/lib/Autonomous-SpawnWorktreeGate.ps1';
const spawnWorktreeSource = read(spawnWorktreeFile);
const escapeAuditIndex = spawnWorktreeSource.indexOf('function Write-AutonomousBoundaryEscapeAudit {');
if (escapeAuditIndex < 0) throw new Error(`${spawnWorktreeFile}: escape-audit marker missing`);
write(spawnWorktreeFile, spawnWorktreeSource.slice(0, escapeAuditIndex).trimEnd());

write(
  'scripts/check-orchestrator-claimed-review-run.ps1',
  `#requires -Version 5.1
<#
  Scoped PR lookup regression guard (Issue #557), retained after Issue #821 retired
  the process-boundary wrapper wiring that previously shared this file.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot

$snapshotPath = Join-Path $RepoRoot 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1'
$snapshotText = Get-Content -LiteralPath $snapshotPath -Raw
if ($snapshotText -match '(?<!ForNumbers)Invoke-GhOpenPrList\\b') {
    Write-Host 'Get-ClaimedReviewStartSnapshot must not call full Invoke-GhOpenPrList when PrNumber is known (#557)'
    exit 1
}
if ($snapshotText -match "'pr',\\s*'list'|gh pr list --state open") {
    Write-Host 'Get-ClaimedReviewStartSnapshot must use scoped PR lookup, not full open-PR list (#557)'
    exit 1
}
if ($snapshotText -notmatch 'Invoke-ReviewStartScopedGhPrView|Invoke-GhOpenPrListForNumbers' -or $snapshotText -notmatch "'pr',\\s*'view'|Invoke-GhPrViewStructuredCapture|Invoke-ReviewStartPreflightGhPrView") {
    Write-Host 'Get-ClaimedReviewStartSnapshot must resolve known PR numbers via scoped stderr-safe lookup (#557/#566)'
    exit 1
}

Write-Host '[PASS] scoped claimed-review PR lookup regression'
exit 0
`,
);

replaceExactly(
  'scripts/check-command-runtime-bootstrap.ps1',
  /\n\$bootstrap = Get-Content -LiteralPath \(Join-Path \$RepoRoot 'scripts\/autonomous-orchestrator-surface-bootstrap\.sh'\) -Raw\nif \(\$bootstrap -notmatch 'command-runtime-bootstrap\\\.mjs'\) \{\n    Write-Host 'autonomous-orchestrator-surface-bootstrap\.sh missing command-runtime preflight hook'\n    exit 1\n\}\n/,
  '\n',
);

replaceExactly(
  'agent-orchestrator.yaml.example',
  /        env:\n[\s\S]*?\n    worker:/,
  '    worker:',
);

const decisionLog = 'docs/issues_drafts/00-architecture-decisions.md';
let decisionText = read(decisionLog);
if (!decisionText.includes('Issue #821 — AO 0.10.2 in-process gate activation')) {
  decisionText += `

## Issue #821 — AO 0.10.2 in-process gate activation and boundary retirement

- In-process spawn, review-start, worker-nudge, and git-boundary gates activate when the daemon-provided session identifier is present.
- Orchestrator and worker roles carry that identifier; the sampled review role, operator shells, and CI do not, so those contexts remain outside the in-process gate.
- The obsolete command interposition and real-binary indirection layer is retired. Direct command invocation is no longer a process-boundary enforcement surface; callers that require policy enforcement must enter through the surviving in-process gates.
- The scoped PR lookup regression from Issue #557 remains independently guarded.
`;
  write(decisionLog, decisionText);
}

const deletedModuleSpecifiers = new Set([
  './_test-interposer-pack-fixture.js',
  './autonomous-orchestrator-interposer.test.js',
]);
const retiredLiteralMarkers = [
  'ao-autonomous-guard.ps1',
  'git-autonomous-guard.ps1',
  'git-real-binary',
  '_invoke-system-git.sh',
  '_resolve-system-git.sh',
  'autonomous-orchestrator-surface-bootstrap.sh',
  'autonomous-bash-env.sh',
  'autonomous-real-binaries.example.json',
  '.ao/autonomous-real-binaries.json',
  'invoke-orchestrator-claimed-review-run.ps1',
  'Invoke-OrchestratorClaimedReviewRun.ps1',
  'check-worker-nudge-gate-adoption.ps1',
];

function rootCallName(expression) {
  let current = expression;
  while (ts.isCallExpression(current)) current = current.expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : '';
}

function updateFunctionBody(node, body) {
  if (ts.isArrowFunction(node)) {
    return ts.factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      node.parameters,
      node.type,
      node.equalsGreaterThanToken,
      body,
    );
  }
  if (ts.isFunctionExpression(node)) {
    return ts.factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      body,
    );
  }
  return node;
}

function transformTestFile(file, extraMarkers = []) {
  const sourceText = read(file);
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const markers = [...retiredLiteralMarkers, ...extraMarkers];
  const containsMarker = (node) => {
    const text = node.getFullText(sourceFile);
    return markers.some((marker) => text.includes(marker));
  };

  const filterBlock = (block) => {
    const statements = [];
    for (const statement of block.statements) {
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        const callName = rootCallName(statement.expression.expression);
        if ((callName === 'it' || callName === 'test') && containsMarker(statement)) continue;
        if (callName === 'describe') {
          const call = statement.expression;
          const args = call.arguments.map((arg) => {
            if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body)) {
              return updateFunctionBody(arg, filterBlock(arg.body));
            }
            return arg;
          });
          statements.push(ts.factory.updateExpressionStatement(statement, ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args)));
          continue;
        }
      }
      statements.push(statement);
    }
    return ts.factory.updateBlock(block, statements);
  };

  const topLevel = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (ts.isStringLiteral(statement.moduleSpecifier) && deletedModuleSpecifiers.has(statement.moduleSpecifier.text)) continue;
      topLevel.push(statement);
      continue;
    }
    if ((ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) && containsMarker(statement)) continue;
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const callName = rootCallName(statement.expression.expression);
      if ((callName === 'it' || callName === 'test') && containsMarker(statement)) continue;
      if (callName === 'describe') {
        const call = statement.expression;
        const args = call.arguments.map((arg) => {
          if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body)) {
            return updateFunctionBody(arg, filterBlock(arg.body));
          }
          return arg;
        });
        topLevel.push(ts.factory.updateExpressionStatement(statement, ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args)));
        continue;
      }
    }
    topLevel.push(statement);
  }

  const updatedSource = ts.factory.updateSourceFile(sourceFile, topLevel);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  let printed = printer.printFile(updatedSource);

  // Prune import specifiers that are no longer referenced after deleting shim-only tests.
  const reparsed = ts.createSourceFile(file, printed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const used = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(reparsed, visit);
  const importsPruned = [];
  for (const statement of reparsed.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      importsPruned.push(statement);
      continue;
    }
    const clause = statement.importClause;
    const defaultName = clause.name && used.has(clause.name.text) ? clause.name : undefined;
    let bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const elements = bindings.elements.filter((element) => used.has(element.name.text));
      bindings = elements.length > 0 ? ts.factory.updateNamedImports(bindings, elements) : undefined;
    } else if (bindings && ts.isNamespaceImport(bindings) && !used.has(bindings.name.text)) {
      bindings = undefined;
    }
    if (!defaultName && !bindings) continue;
    const nextClause = ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName, bindings);
    importsPruned.push(ts.factory.updateImportDeclaration(statement, statement.modifiers, nextClause, statement.moduleSpecifier, statement.attributes));
  }
  printed = printer.printFile(ts.factory.updateSourceFile(reparsed, importsPruned));
  write(file, printed);
}

transformTestFile('scripts/autonomous-spawn-policy.test.ts', [
  'withAoSpawnProbeStub',
  'autonomousBashEnv',
  'isolatedGuardPath',
  'isolatedGitGuardPath',
  'pack.aoShimPath',
]);
transformTestFile('scripts/worker-nudge-gate.test.ts', [
  'writeDownstreamAoStub',
  'withAutonomousRealBinariesConfig',
  'autonomousProductionChainEnv',
  'pack.aoShimPath',
]);
transformTestFile('scripts/orchestrator-claimed-review-run.test.ts', [
  'invokePath',
  'helperPath',
  'guardPath',
  'aoShimPath',
]);
transformTestFile('scripts/autonomous-orchestrator-boundary.test.ts', [
  'guardPath',
  'gitGuardPath',
  'gitRealBinaryPath',
  'bashEnvPath',
  'aoShimPath',
  'gitShimPath',
  'spawnAutonomousBashTurn',
  'autonomousBashEnv',
  'withAoSpawnProbeStub',
  'spawnHermeticBoundaryBash',
  'stripInterposerBashEnvBlockers',
  'buildHermeticSpawnGateEnv',
  'assertSpawnGateIsolationPreflight',
  'autonomousClaimPrProbeEnv',
  'autonomousSpawnFixtureProbeEnv',
]);

write(
  'scripts/autonomous-session-gates.test.ts',
  `import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const spawnGate = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const reviewGate = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1');
const workerGate = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
const boundary = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');

function evaluateSessionCell(sessionId: string | null) {
  const literal = sessionId === null ? '$null' : psString(sessionId);
  const output = runPwsh(\`
    $prior = $env:AO_SESSION_ID
    try {
      if (\${literal} -eq $null) { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
      else { $env:AO_SESSION_ID = \${literal} }
      . \${psString(spawnGate)}
      . \${psString(reviewGate)}
      . \${psString(workerGate)}
      . \${psString(boundary)}
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
      if ($prior) { $env:AO_SESSION_ID = $prior } else { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
    }
  \`);
  return JSON.parse(output.trim());
}

describe('AO 0.10.2 in-process autonomous gate activation (#821)', () => {
  it.each([
    ['orchestrator', 'orchestrator-session'],
    ['worker', 'worker-session'],
  ])('%s session activates all shared predicates', (_role, sessionId) => {
    const result = evaluateSessionCell(sessionId);
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
  ])('%s without a session id remains outside the in-process gate', (_role, sessionId) => {
    const result = evaluateSessionCell(sessionId);
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

  it('uses presence rather than a magic value', () => {
    const result = evaluateSessionCell('worker-any-nonempty-value');
    expect(result.spawn).toBe(true);
    expect(result.review).toBe(true);
    expect(result.boundary).toBe(true);
  });

  it('retains the claimed review bypass without changing its reason', () => {
    const output = runPwsh(\`
      . \${psString(reviewGate)}
      $env:AO_SESSION_ID = 'orchestrator-session'
      $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
      (Test-AutonomousRawReviewRunDenied -Argv @('review','run')) | ConvertTo-Json -Compress
    \`);
    const result = JSON.parse(output.trim());
    expect(result.denied).toBe(false);
    expect(result.reason).toBe('claimed_bypass');
  });

  it('accepts direct command invocation as ungated after boundary wrappers retire', () => {
    for (const retired of [
      'scripts/ao',
      'scripts/git',
      'scripts/ao-autonomous-guard.ps1',
      'scripts/git-autonomous-guard.ps1',
    ]) {
      expect(existsSync(path.join(repoRoot, retired))).toBe(false);
    }
  });
});
`,
);

// Remove obsolete fixture imports only when no surviving test references them.
const interposerHelperUsers = trackedFiles().filter(
  (file) => file.endsWith('.ts') && file !== 'scripts/_test-autonomous-ao-stub-fixture.ts' && existsSync(abs(file)) && read(file).includes('_test-autonomous-ao-stub-fixture'),
);
if (interposerHelperUsers.length === 0) remove('scripts/_test-autonomous-ao-stub-fixture.ts');

// Remove simple residual references from the example and CI/guard inventories where each
// reference occupies its own line. Code-bearing residuals are reported below instead.
const lineSafeFiles = trackedFiles().filter((file) =>
  existsSync(abs(file)) &&
  !isHistorical(file) &&
  (file === 'agent-orchestrator.yaml.example' || file.startsWith('.github/workflows/') || /^scripts\/check-.*\.ps1$/.test(file)),
);
for (const file of lineSafeFiles) {
  const source = read(file);
  const lines = source.split('\n');
  const filtered = lines.filter((line) => !retiredLiteralMarkers.some((marker) => line.includes(marker)));
  if (filtered.length !== lines.length) write(file, filtered.join('\n'));
}

const residualMarkers = [
  'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE',
  ...retiredLiteralMarkers,
];
const residuals = [];
for (const file of trackedFiles()) {
  if (isHistorical(file) || !existsSync(abs(file))) continue;
  const buffer = readFileSync(abs(file));
  if (buffer.includes(0)) continue;
  const source = buffer.toString('utf8');
  for (const marker of residualMarkers) {
    if (!source.includes(marker)) continue;
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(marker)) residuals.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (residuals.length > 0) {
  console.error('ISSUE_821_RESIDUAL_REFERENCES_BEGIN');
  for (const item of residuals) console.error(item);
  console.error('ISSUE_821_RESIDUAL_REFERENCES_END');
  process.exitCode = 2;
} else {
  console.log('Issue #821 migration produced no non-historical retired-surface references.');
}
