import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const abs = (file) => path.join(root, file);
const rel = (file) => file.replaceAll('\\', '/');

function read(file) {
  return readFileSync(abs(file), 'utf8');
}

function write(file, content) {
  const normalized = String(content).replaceAll('\r\n', '\n');
  writeFileSync(abs(file), normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8');
}

function remove(file) {
  if (existsSync(abs(file))) rmSync(abs(file), { recursive: true, force: true });
}

function replaceExact(file, pattern, replacement, expected = 1) {
  const source = read(file);
  let count = 0;
  const updated = source.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count !== expected) {
    throw new Error(`${file}: expected ${expected} replacement(s), got ${count}`);
  }
  write(file, updated);
}

function walk(dir) {
  const out = [];
  if (!existsSync(abs(dir))) return out;
  for (const entry of readdirSync(abs(dir), { withFileTypes: true })) {
    const file = rel(path.join(dir, entry.name));
    if (entry.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(rel);
}

function parseJson(file) {
  return JSON.parse(read(file));
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2));
}

for (const file of trackedFiles()) {
  if (/^issue-821(?:-|\.)/.test(file)) remove(file);
}

for (const file of [
  'scripts/_test-spawn-budget-fixture.ts',
  'scripts/autonomous-spawn-budget.test.ts',
  'scripts/review-pipeline-spawn-budget.test.ts',
  'tests/external-output-references/review-pipeline-spawn-budget',
]) {
  remove(file);
}

writeJson('docs/autonomous-shared-capabilities.json', {
  capabilities: [
    {
      id: 'autonomous-session-id',
      classification: 'gated',
      surface: 'process-env',
      path: 'AO_SESSION_ID',
    },
    {
      id: 'autonomous-spawn-gate',
      classification: 'gated',
      surface: 'in-process',
      path: 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1',
    },
    {
      id: 'autonomous-review-start-gate',
      classification: 'gated',
      surface: 'in-process',
      path: 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1',
    },
    {
      id: 'autonomous-worker-nudge-gate',
      classification: 'gated',
      surface: 'in-process',
      path: 'scripts/lib/Worker-AutonomousNudgeGate.ps1',
    },
    {
      id: 'autonomous-git-boundary',
      classification: 'gated',
      surface: 'in-process',
      path: 'scripts/lib/Orchestrator-AutonomousBoundary.ps1',
    },
  ],
});

writeJson('docs/autonomous-review-start-capabilities.json', {
  version: 'orchestrator-claimed-review-run/v1',
  boundaryVersion: 'autonomous-orchestrator-boundary/v1',
  atomicClaimCapability: 'review-start-claim-atomic/v1',
  sharedCapabilitiesPath: 'docs/autonomous-shared-capabilities.json',
  capabilities: [
    {
      id: 'review-start-claim-atomic',
      classification: 'gated',
      surface: 'in-process',
      path: 'scripts/lib/Review-StartClaim.ps1',
    },
    {
      id: 'invoke-manual-review-run',
      classification: 'gated',
      surface: 'shell',
      path: 'scripts/invoke-manual-review-run.ps1',
      provenance: 'manual-operator',
    },
    {
      id: 'git-claimed-worktree-add',
      classification: 'gated',
      surface: 'claim-store',
      path: 'scripts/lib/Autonomous-ReviewWorktreeGate.ps1',
      provenance: 'live-review-start-claim',
    },
    {
      id: 'invoke-worker-recovery',
      classification: 'gated',
      surface: 'shell',
      path: 'scripts/invoke-worker-recovery.ps1',
      provenance: 'worker-recovery-claim',
    },
  ],
  sanctionedGitParents: [
    'reviewer-workspace-preflight.ps1',
    'orchestrator-worktree-preflight.ps1',
    'invoke-worker-recovery.ps1',
  ],
  sanctionedGitParentMaxDepth: 2,
});

const workerInventory = parseJson('docs/autonomous-worker-nudge-capabilities.json');
workerInventory.capabilities = (workerInventory.capabilities ?? []).filter(
  (row) => row.id !== 'ao-worker-send-raw',
);
if (!workerInventory.capabilities.some((row) => row.id === 'worker-nudge-claim-atomic')) {
  workerInventory.capabilities.unshift({
    id: 'worker-nudge-claim-atomic',
    classification: 'gated',
    surface: 'in-process',
    path: 'scripts/lib/Worker-NudgeClaim.ps1',
  });
}
writeJson('docs/autonomous-worker-nudge-capabilities.json', workerInventory);

replaceExact(
  'docs/autonomous-gate-preflight.mjs',
  / \* @param \{string\} config\.rawCapabilityId\n \* @param \{string\} config\.rawNotUnavailableReason\n \* @param \{string\[\]\} \[config\.extraRequiredUnavailable\]\n/,
  ' * @param {Array<{ id: string, classification: string, reason?: string }>} [config.requiredCapabilities]\n * @param {string} [config.rawCapabilityId]\n * @param {string} [config.rawNotUnavailableReason]\n * @param {string[]} [config.extraRequiredUnavailable]\n',
);
replaceExact(
  'docs/autonomous-gate-preflight.mjs',
  /  const raw = toArray\(input\.liveCapabilities\)\.find\(\(row\) => row\.id === config\.rawCapabilityId\);[\s\S]*?  return \{ ok: true, reason: 'gate_preflight_ok', auditShape: 'none' \};/,
  `  const requiredCapabilities = config.requiredCapabilities ?? [
    ...(config.rawCapabilityId
      ? [{
          id: config.rawCapabilityId,
          classification: 'unavailable',
          reason: config.rawNotUnavailableReason,
        }]
      : []),
    ...(config.extraRequiredUnavailable ?? []).map((id) => ({
      id,
      classification: 'unavailable',
    })),
  ];
  for (const required of requiredCapabilities) {
    const row = toArray(input.liveCapabilities).find((capability) => capability.id === required.id);
    if (!row) {
      return {
        ok: false,
        reason: \`\${required.id}_missing\`,
        auditShape: 'preflight_refusal',
        markerState: required.id,
      };
    }
    if (String(row.classification).toLowerCase() !== String(required.classification).toLowerCase()) {
      return {
        ok: false,
        reason: required.reason ?? \`\${required.id}_not_\${required.classification}\`,
        auditShape: 'preflight_refusal',
        markerState: required.id,
      };
    }
  }
  return { ok: true, reason: 'gate_preflight_ok', auditShape: 'none' };`,
);

replaceExact(
  'docs/orchestrator-claimed-review-run.mjs',
  /  return evaluateAutonomousGatePreflight\(input, \{\n    expectedGateVersion: ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION,\n    atomicClaimCapability: ATOMIC_REVIEW_START_CLAIM_CAPABILITY,\n    rawCapabilityId: 'ao-review-run-raw',\n    rawNotUnavailableReason: 'raw_review_run_not_unavailable',\n    extraRequiredUnavailable: \['ao-spawn-raw', 'git-mutating-direct', 'turn-visible-real-binary-env'\],\n  \}\);/,
  `  return evaluateAutonomousGatePreflight(input, {
    expectedGateVersion: ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION,
    atomicClaimCapability: ATOMIC_REVIEW_START_CLAIM_CAPABILITY,
    requiredCapabilities: [
      { id: 'autonomous-session-id', classification: 'gated' },
      { id: 'autonomous-review-start-gate', classification: 'gated' },
      { id: 'review-start-claim-atomic', classification: 'gated' },
    ],
  });`,
);

replaceExact(
  'docs/worker-nudge-gate.mjs',
  /  return evaluateAutonomousGatePreflight\(input, \{\n    expectedGateVersion: WORKER_NUDGE_GATE_VERSION,\n    atomicClaimCapability: ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY,\n    rawCapabilityId: 'ao-worker-send-raw',\n    rawNotUnavailableReason: 'raw_worker_send_not_unavailable',\n  \}\);/,
  `  return evaluateAutonomousGatePreflight(input, {
    expectedGateVersion: WORKER_NUDGE_GATE_VERSION,
    atomicClaimCapability: ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY,
    requiredCapabilities: [
      { id: 'autonomous-session-id', classification: 'gated' },
      { id: 'autonomous-worker-nudge-gate', classification: 'gated' },
      { id: 'worker-nudge-claim-atomic', classification: 'gated' },
      { id: 'journaled-worker-send-gated', classification: 'gated' },
    ],
  });`,
);

const boundaryModel = 'docs/autonomous-orchestrator-boundary.mjs';
replaceExact(boundaryModel, /export const TURN_VISIBLE_REAL_BINARY_ENV_VARS = \['AO_REAL_BINARY', 'GIT_REAL_BINARY'\];\n/, '');
replaceExact(boundaryModel, /const CLAIMED_REVIEW_RUN_INVOKER = 'Invoke-OrchestratorClaimedReviewRun\.ps1';\n/, '');
replaceExact(
  boundaryModel,
  /\/\*\*\n \* @param \{string\} candidatePath[\s\S]*?(?=\/\*\*\n \* @param \{string\[\]\} argv\n \*\/\nexport function isGitArgvAoOwnedWorktreeAdd)/,
  '',
);
replaceExact(
  boundaryModel,
  /  for \(const line of chain\.slice\(0, depthLimit\)\) \{\n    if \(isSanctionedGitParentCommandLine\(line, \[CLAIMED_REVIEW_RUN_INVOKER\]\)\) \{\n      return 'claimed_review_run';\n    \}\n    if \(isAoReviewRunGitWorktreeSetupCommandLine\(line\)\) \{\n      return 'review_run_worktree_command';\n    \}\n  \}/,
  `  for (const line of chain.slice(0, depthLimit)) {
    if (isAoReviewRunGitWorktreeSetupCommandLine(line)) {
      return 'review_run_worktree_command';
    }
  }`,
);
replaceExact(
  boundaryModel,
  /\/\*\*\n \* @param \{string\} segment[\s\S]*?(?=\/\*\*\n \* @param \{object\} input\n \* @param \{Array<\{ id: string, classification: string \}>\} \[input\.liveCapabilities\])/, 
  '',
);
replaceExact(
  boundaryModel,
  /export function evaluateBoundaryCapabilityPreflight\(input\) \{[\s\S]*?\n\}/,
  `export function evaluateBoundaryCapabilityPreflight(input) {
  const violations = [];
  const rows = Array.isArray(input.liveCapabilities) ? input.liveCapabilities : [];
  const byId = new Map(rows.map((row) => [String(row.id), String(row.classification)]));
  for (const id of [
    'autonomous-session-id',
    'autonomous-spawn-gate',
    'autonomous-review-start-gate',
    'autonomous-worker-nudge-gate',
    'autonomous-git-boundary',
  ]) {
    if (byId.get(id) !== 'gated') {
      violations.push(\`\${id}_not_gated\`);
    }
  }
  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? 'boundary_preflight_ok' : violations.join(','),
    boundaryVersion: AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION,
  };
}`,
);
replaceExact(boundaryModel, /  evaluateTurnBypass: \(\) => evaluateTurnVisibleRealBinaryBypass\(readStdinJson\(\)\),\n/, '');

const boundaryPs = 'scripts/lib/Orchestrator-AutonomousBoundary.ps1';
const boundaryPsSource = read(boundaryPs);
const parentMarker = 'function Get-LinuxParentProcessId {';
const parentIndex = boundaryPsSource.indexOf(parentMarker);
if (parentIndex < 0) throw new Error(`${boundaryPs}: parent marker missing`);
const boundaryHeader = `#requires -Version 5.1
<#
  In-process autonomous spawn/git policy helpers (Issues #324/#821).
#>

. (Join-Path $PSScriptRoot 'Get-ProcessCommandLine.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-ReviewWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-SpawnWorktreeGate.ps1')
. (Join-Path $PSScriptRoot 'Autonomous-WorkerRecoveryGate.ps1')

$Script:AutonomousBoundaryExitCode = 93
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

`;
write(boundaryPs, boundaryHeader + boundaryPsSource.slice(parentIndex));

replaceExact(
  'scripts/lib/Test-AutonomousCapabilityInventory.ps1',
  /    if \(\$IncludeBoundaryChecks\) \{\n        foreach \(\$id in @\('ao-spawn-raw'[\s\S]*?\n    \}\n\n    return @\(\$violations\)/,
  `    if ($IncludeBoundaryChecks) {
        foreach ($id in @(
            'autonomous-session-id',
            'autonomous-spawn-gate',
            'autonomous-review-start-gate',
            'autonomous-worker-nudge-gate',
            'autonomous-git-boundary'
        )) {
            $row = $repoInventory | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
            if (-not $row -or [string]$row.classification -ne 'gated') {
                $violations.Add("required in-process capability missing or misclassified: $id")
            }
        }

        $boundaryCli = Join-Path $RepoRoot 'docs/autonomous-orchestrator-boundary.mjs'
        if (-not (Test-Path -LiteralPath $boundaryCli)) {
            $violations.Add('missing docs/autonomous-orchestrator-boundary.mjs')
        }
        else {
            $payload = @{
                liveCapabilities = @($repoInventory | ForEach-Object { @{ id = [string]$_.id; classification = [string]$_.classification } })
            } | ConvertTo-Json -Compress -Depth 5
            $boundaryValidation = $payload | node $boundaryCli evaluatePreflight 2>$null | ConvertFrom-Json
            if (-not $boundaryValidation.ok) {
                $violations.Add("boundary preflight validation failed: $($boundaryValidation.reason)")
            }
        }
    }

    return @($violations)`,
);
replaceExact(
  'scripts/lib/Test-AutonomousCapabilityInventory.ps1',
  /        if \(\$rel -match 'invoke-orchestrator-claimed-review-run\|invoke-manual-review-run\|ao-autonomous-guard\|git-autonomous-guard\|scripts\/ao\$\|scripts\/git\$\|Invoke-OrchestratorClaimedReviewRun'\) \{/,
  "        if ($rel -match 'invoke-manual-review-run') {",
);

const yamlFile = 'agent-orchestrator.yaml.example';
replaceExact(
  yamlFile,
  /      Historical claimed entry point \(non-routine — not the 0\.10 default path\):\n          -SessionId <worker-session-id> -PrNumber <pr-number> \[-EventHeadSha <wake-or-report-sha>\]\n      Process-boundary enforcement \(fail-closed\):[\s\S]*?      orchestrator-claimed-review-run\/v1 and autonomous-orchestrator-boundary\/v1\.\n/,
  `      IN-PROCESS AUTONOMOUS GATES (Issue #821): AO 0.10.2 injects a non-empty
      AO_SESSION_ID into orchestrator and worker sessions. Shared spawn, review-start,
      worker-nudge, and git policy gates activate from presence of that identifier.
      The sampled review role, operator shells, and CI have no AO_SESSION_ID and remain
      outside those in-process gates. PATH shims, real-binary indirection, and the
      claimed-run shell wrapper are retired; direct ao/git shell invocation is not a
      process-boundary enforcement surface.
`,
);
replaceExact(
  yamlFile,
  /      Command-runtime bootstrap \(refuses command turns when tools\/PATH are incomplete\):\n      pwsh -NoProfile -File scripts\/orchestrator-command-runtime-preflight\.ps1/,
  `      Command-runtime bootstrap (refuses command turns when tools/PATH are incomplete):
      capability marker: command-runtime-bootstrap/v1
      pwsh -NoProfile -File scripts/orchestrator-command-runtime-preflight.ps1`,
);

const runbook = 'docs/orchestrator-recovery-runbook.md';
if (existsSync(abs(runbook)) && read(runbook).includes('scripts/check-worker-nudge-gate-adoption.ps1')) {
  write(
    runbook,
    read(runbook).replaceAll(
      '`pwsh -NoProfile -File scripts/check-worker-nudge-gate-adoption.ps1` passes.',
      '`pwsh -NoProfile -File scripts/check-autonomous-capabilities.ps1 -ReviewStart` passes, and `scripts/autonomous-session-gates.test.ts` covers the AO 0.10.2 role matrix.',
    ),
  );
}

const auditRoots = 'scripts/orchestrator-message-audit-roots.manifest.json';
if (existsSync(abs(auditRoots))) {
  const manifest = parseJson(auditRoots);
  const retiredNames = [
    'scripts/ao-autonomous-guard.ps1',
    'scripts/git-autonomous-guard.ps1',
    'scripts/invoke-orchestrator-claimed-review-run.ps1',
    'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
  ];
  for (const [key, value] of Object.entries(manifest)) {
    if (Array.isArray(value)) manifest[key] = value.filter((item) => !retiredNames.includes(String(item)));
  }
  writeJson(auditRoots, manifest);
}

replaceExact(
  'scripts/autonomous-session-gates.test.ts',
  /    finally \{\n      if \(\$prior\) \{ \$env:AO_SESSION_ID = \$prior \} else \{ Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue \}\n    \}\n  `\);/,
  `    finally {
      if ($prior) { $env:AO_SESSION_ID = $prior } else { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
    }
    exit 0
  \`);`,
);

const baseMarkers = [
  '.ao/autonomous-real-binaries.json',
  'autonomous-real-binaries.example.json',
  'ao-autonomous-guard.ps1',
  'git-autonomous-guard.ps1',
  'git-real-binary',
  '_invoke-system-git.sh',
  '_resolve-system-git.sh',
  'autonomous-orchestrator-surface-bootstrap.sh',
  'autonomous-bash-env.sh',
  'Invoke-OrchestratorClaimedReviewRun.ps1',
  'invoke-orchestrator-claimed-review-run.ps1',
  'check-worker-nudge-gate-adoption.ps1',
  '_test-interposer-pack-fixture',
  '_test-spawn-budget-fixture',
  'pack.aoShimPath',
  'pack.gitShimPath',
  'withBrokenAoPointerFixture',
  'claimedRunLib',
  'orchestratorClaimedPath',
  'evaluateConfiguredGitBinaryBypass',
  'evaluateAbsoluteSystemGitInvocationBoundary',
  'evaluateTurnVisibleRealBinaryBypass',
  'isKnownSystemGitBinaryPath',
  'turn-visible real binary',
  'ao shim denies raw worker send on autonomous surface',
  'raw ao send on autonomous surface is internal capability deny exit 93',
  'raw ao send --help without capability is internal capability deny exit 93',
];
const deletedModules = [
  '_test-autonomous-ao-stub-fixture',
  '_test-interposer-pack-fixture',
  '_test-spawn-budget-fixture',
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

function importedIdentifiersForDeletedModules(sourceFile) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!deletedModules.some((moduleName) => statement.moduleSpecifier.text.includes(moduleName))) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.push(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.push(element.name.text);
    }
  }
  return names;
}

function transformTestFile(file) {
  let sourceText = read(file);
  if (!baseMarkers.some((marker) => sourceText.includes(marker)) && !deletedModules.some((marker) => sourceText.includes(marker))) {
    return;
  }
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const markers = [...baseMarkers, ...importedIdentifiersForDeletedModules(sourceFile)];
  const containsMarker = (node) => {
    const text = node.getFullText(sourceFile).toLowerCase();
    return markers.some((marker) => text.includes(marker.toLowerCase()));
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
          const callback = args.find((arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body));
          if (callback && ts.isBlock(callback.body) && callback.body.statements.length === 0) continue;
          statements.push(ts.factory.updateExpressionStatement(
            statement,
            ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args),
          ));
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
      if (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        deletedModules.some((moduleName) => statement.moduleSpecifier.text.includes(moduleName))
      ) {
        continue;
      }
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
        const callback = args.find((arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body));
        if (callback && ts.isBlock(callback.body) && callback.body.statements.length === 0) continue;
        topLevel.push(ts.factory.updateExpressionStatement(
          statement,
          ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args),
        ));
        continue;
      }
    }
    topLevel.push(statement);
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  let printed = printer.printFile(ts.factory.updateSourceFile(sourceFile, topLevel));
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
    importsPruned.push(ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName, bindings),
      statement.moduleSpecifier,
      statement.attributes,
    ));
  }
  printed = printer.printFile(ts.factory.updateSourceFile(reparsed, importsPruned));
  write(file, printed);
}

for (const file of walk('scripts').filter((item) => item.endsWith('.test.ts'))) {
  if (file === 'scripts/autonomous-session-gates.test.ts') continue;
  transformTestFile(file);
}

const helperNeedle = '_test-autonomous-ao-stub-fixture';
const helperUsers = trackedFiles().filter(
  (file) => file !== 'scripts/_test-autonomous-ao-stub-fixture.ts' && existsSync(abs(file)) && !statSync(abs(file)).isDirectory() && readFileSync(abs(file)).toString().includes(helperNeedle),
);
if (helperUsers.length === 0) {
  remove('scripts/_test-autonomous-ao-stub-fixture.ts');
} else {
  throw new Error(`remaining ${helperNeedle} users: ${helperUsers.join(', ')}`);
}

// Remove stale #819 protected-test references without re-running its deletion analysis.
const reachability = 'scripts/reachability-purge.mjs';
if (existsSync(abs(reachability))) {
  write(
    reachability,
    read(reachability)
      .replace("  'scripts/autonomous-orchestrator-interposer.test.ts',\n", '')
      .replace("  'scripts/autonomous-spawn-budget.test.ts',\n", '')
      .replace("  'scripts/review-pipeline-spawn-budget.test.ts',\n", ''),
  );
}

const residualForbidden = [
  'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE',
  '.ao/autonomous-real-binaries.json',
];
const residuals = [];
for (const file of trackedFiles()) {
  if (!existsSync(abs(file)) || statSync(abs(file)).isDirectory()) continue;
  if (file.startsWith('docs/issues_drafts/') || file === 'docs/migration_notes.md') continue;
  if (file.startsWith('docs/declarations/')) continue;
  if (file === 'scripts/reachability-purge.manifest.json') continue;
  const buffer = readFileSync(abs(file));
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const marker of residualForbidden) {
    if (!text.includes(marker)) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(marker)) residuals.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
}
if (residuals.length > 0) {
  throw new Error(`active retired-surface references remain:\n${residuals.join('\n')}`);
}

console.log('Issue #821 finalization transform complete.');
