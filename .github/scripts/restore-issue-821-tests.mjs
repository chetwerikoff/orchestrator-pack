import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as ts from 'typescript';

function fromMain(file) {
  return execFileSync('git', ['show', `origin/main:${file}`], { encoding: 'utf8' });
}

function write(file, text) {
  writeFileSync(file, text.replaceAll('\r\n', '\n'), 'utf8');
}

function rootCallName(expression) {
  let current = expression;
  while (ts.isCallExpression(current)) current = current.expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : '';
}

function removeTestsAndFunctions(source, file, testTitles, functionNames) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges = [];
  const foundTests = new Set();
  const foundFunctions = new Set();

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text)) {
      ranges.push([node.getFullStart(), node.getEnd()]);
      foundFunctions.add(node.name.text);
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (rootCallName(call.expression) === 'it') {
        const arg = call.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && testTitles.has(arg.text)) {
          ranges.push([node.getFullStart(), node.getEnd()]);
          foundTests.add(arg.text);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  const missingTests = [...testTitles].filter((title) => !foundTests.has(title));
  const missingFunctions = [...functionNames].filter((name) => !foundFunctions.has(name));
  if (missingTests.length || missingFunctions.length) {
    throw new Error(`${file}: missing tests=${missingTests.join('|')} functions=${missingFunctions.join('|')}`);
  }

  ranges.sort((a, b) => b[0] - a[0]);
  let output = source;
  for (const [start, end] of ranges) output = output.slice(0, start) + output.slice(end);
  return output;
}

function replaceOne(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label}: expected one exact match`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

const spawnFile = 'scripts/autonomous-spawn-worktree-gate.test.ts';
let spawnSource = fromMain(spawnFile);
spawnSource = removeTestsAndFunctions(
  spawnSource,
  spawnFile,
  new Set([
    'boundary escape audit detects surface unset after bootstrap',
    'guard integration: allowed spawn sets grant env for downstream git',
    'unsanctioned mutating git still denied on autonomous surface',
  ]),
  new Set(),
);
spawnSource = spawnSource
  .replace("  evaluateBoundaryEscapeSignal,\n", '')
  .replace("import { autonomousSpawnFixtureProbeEnv, withAoSpawnProbeStub } from './_test-autonomous-ao-stub-fixture.js';\n", '')
  .replace("import { autonomousBashEnv } from './_test-git-fixture.js';\n", '')
  .replace("const gitGuardPath = path.join(repoRoot, 'scripts/git-autonomous-guard.ps1');\n", '')
  .replaceAll('AO_AUTONOMOUS_ORCHESTRATOR_SURFACE', 'AO_SESSION_ID');
write(spawnFile, spawnSource);

const workerFile = 'scripts/worker-nudge-gate.test.ts';
let workerSource = fromMain(workerFile);
workerSource = removeTestsAndFunctions(
  workerSource,
  workerFile,
  new Set([
    'ao shim denies raw worker send on autonomous surface',
    'production chain help probe: journaled-worker-send DryRun preflight through real scripts/ao',
    'production chain delivery: gated journaled send through real scripts/ao and guard',
    'raw ao send on autonomous surface is internal capability deny exit 93',
    'raw ao send --help without capability is internal capability deny exit 93',
    'TTL-expired internal capability token is internal capability deny exit 93',
    'sibling ao send --file with live unconsumed token is internal capability deny exit 93',
  ]),
  new Set([
    'writeDownstreamAoStub',
    'withAutonomousRealBinariesConfig',
    'autonomousProductionChainEnv',
  ]),
);
workerSource = workerSource
  .replace(
    "import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  )
  .replace("import { AO_SEND_0102_HELP } from './_ao-send-0102-test-fixture.js';\n", '')
  .replaceAll('AO_AUTONOMOUS_ORCHESTRATOR_SURFACE', 'AO_SESSION_ID');
workerSource = replaceOne(
  workerSource,
  `  it('preflight fails closed when raw send capability is missing from live inventory', () => {
    const result = evaluatePreflight({
      loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
      atomicClaimPresent: true,
      liveCapabilities: [
        { id: 'invoke-gated-worker-nudge', classification: 'gated' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ao-worker-send-raw_missing');
  });

  it('preflight passes with gated inventory', () => {
    const result = evaluatePreflight({
      loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
      atomicClaimPresent: true,
      liveCapabilities: [
        { id: 'invoke-gated-worker-nudge', classification: 'gated' },
        { id: 'ao-worker-send-raw', classification: 'unavailable' },
      ],
    });
    expect(result.ok).toBe(true);
  });`,
  `  it('preflight fails closed when the daemon session capability is missing', () => {
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
  });`,
  'worker preflight tests',
);
write(workerFile, workerSource);

console.log('Restored minimal issue #821 test diffs.');
