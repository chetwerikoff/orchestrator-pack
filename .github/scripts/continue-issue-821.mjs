import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

const root = process.cwd();
const abs = (file) => path.join(root, file);
const rel = (file) => file.replaceAll('\\', '/');
const read = (file) => readFileSync(abs(file), 'utf8');
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
  if (count !== expected) throw new Error(`${file}: expected ${expected} replacement(s), got ${count}`);
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
    .split('\0').filter(Boolean).map(rel);
}
function parseJson(file) { return JSON.parse(read(file)); }
function writeJson(file, value) { write(file, JSON.stringify(value, null, 2)); }

for (const file of trackedFiles()) {
  if (/^issue-821(?:-|\.)/.test(file)) remove(file);
}

replaceExact(
  'agent-orchestrator.yaml.example',
  /      ROUTINE REVIEW TRIGGER \(script-owned — operator reference prose; NOT an LLM turn\n      checklist on AO 0\.10\)\. Routine review rounds are started by side-process scripts\n      named above — the LLM orchestrator turn does not start or drive them\. The block\n      below documents legacy import \/ operator reference only\. Historical claimed entry\n      point \(non-routine — not the 0\.10 default path\):\n          -SessionId <worker-session-id> -PrNumber <pr-number> \[-EventHeadSha <wake-or-report-sha>\]\n      Process-boundary enforcement \(fail-closed\): autonomous orchestrator sessions set\n      AO_SESSION_ID=1, resolve real ao\/git out-of-band via\n      and prepend pack scripts\/ to PATH so `ao`, `git`, and `gh` resolve to pack shims \(deny spawn and\n      direct tree-mutating git; #318 review-run gate \+ #324 spawn\/git boundary\);\n      only the claimed entry point may launch review runs\. Gate capability markers:\n      orchestrator-claimed-review-run\/v1 and autonomous-orchestrator-boundary\/v1\.\n/,
  `      ROUTINE REVIEW TRIGGER (script-owned — operator reference prose; NOT an LLM turn
      checklist on AO 0.10). Routine review rounds are started by side-process scripts
      named above — the LLM orchestrator turn does not start or drive them. The block
      below documents legacy import / operator reference only.
      IN-PROCESS AUTONOMOUS GATES (Issue #821): AO 0.10.2 injects a non-empty
      AO_SESSION_ID into orchestrator and worker sessions. Shared spawn, review-start,
      worker-nudge, and git policy gates activate from presence of that identifier.
      The sampled review role, operator shells, and CI have no AO_SESSION_ID and remain
      outside those in-process gates. PATH shims, real-binary indirection, and the
      claimed-run shell wrapper are retired; direct ao/git shell invocation is not a
      process-boundary enforcement surface.
`,
);
replaceExact(
  'agent-orchestrator.yaml.example',
  /      Command-runtime bootstrap \(refuses command turns when tools\/PATH are incomplete\):\n      pwsh -NoProfile -File scripts\/orchestrator-command-runtime-preflight\.ps1/,
  `      Command-runtime bootstrap (refuses command turns when tools/PATH are incomplete):
      capability marker: command-runtime-bootstrap/v1
      pwsh -NoProfile -File scripts/orchestrator-command-runtime-preflight.ps1`,
);

const runbook = 'docs/orchestrator-recovery-runbook.md';
if (existsSync(abs(runbook))) {
  const source = read(runbook);
  if (source.includes('scripts/check-worker-nudge-gate-adoption.ps1')) {
    write(
      runbook,
      source.replaceAll(
        '`pwsh -NoProfile -File scripts/check-worker-nudge-gate-adoption.ps1` passes.',
        '`pwsh -NoProfile -File scripts/check-autonomous-capabilities.ps1 -ReviewStart` passes, and `scripts/autonomous-session-gates.test.ts` covers the AO 0.10.2 role matrix.',
      ),
    );
  }
}

const auditRoots = 'scripts/orchestrator-message-audit-roots.manifest.json';
if (existsSync(abs(auditRoots))) {
  const manifest = parseJson(auditRoots);
  const retiredNames = new Set([
    'scripts/ao-autonomous-guard.ps1',
    'scripts/git-autonomous-guard.ps1',
    'scripts/invoke-orchestrator-claimed-review-run.ps1',
    'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
  ]);
  for (const [key, value] of Object.entries(manifest)) {
    if (Array.isArray(value)) manifest[key] = value.filter((item) => !retiredNames.has(String(item)));
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
    return ts.factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, body);
  }
  if (ts.isFunctionExpression(node)) {
    return ts.factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
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
  const sourceText = read(file);
  if (!baseMarkers.some((marker) => sourceText.includes(marker)) && !deletedModules.some((marker) => sourceText.includes(marker))) return;
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
            if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body)) return updateFunctionBody(arg, filterBlock(arg.body));
            return arg;
          });
          const callback = args.find((arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body));
          if (callback && ts.isBlock(callback.body) && callback.body.statements.length === 0) continue;
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
      if (ts.isStringLiteral(statement.moduleSpecifier) && deletedModules.some((moduleName) => statement.moduleSpecifier.text.includes(moduleName))) continue;
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
          if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body)) return updateFunctionBody(arg, filterBlock(arg.body));
          return arg;
        });
        const callback = args.find((arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body));
        if (callback && ts.isBlock(callback.body) && callback.body.statements.length === 0) continue;
        topLevel.push(ts.factory.updateExpressionStatement(statement, ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args)));
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
    importsPruned.push(ts.factory.updateImportDeclaration(statement, statement.modifiers, ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName, bindings), statement.moduleSpecifier, statement.attributes));
  }
  write(file, printer.printFile(ts.factory.updateSourceFile(reparsed, importsPruned)));
}
for (const file of walk('scripts').filter((item) => item.endsWith('.test.ts'))) {
  if (file !== 'scripts/autonomous-session-gates.test.ts') transformTestFile(file);
}

const helperNeedle = '_test-autonomous-ao-stub-fixture';
const helperUsers = trackedFiles().filter((file) => {
  if (file === 'scripts/_test-autonomous-ao-stub-fixture.ts' || !existsSync(abs(file)) || statSync(abs(file)).isDirectory()) return false;
  return readFileSync(abs(file)).toString().includes(helperNeedle);
});
if (helperUsers.length === 0) remove('scripts/_test-autonomous-ao-stub-fixture.ts');
else throw new Error(`remaining ${helperNeedle} users: ${helperUsers.join(', ')}`);

const reachability = 'scripts/reachability-purge.mjs';
if (existsSync(abs(reachability))) {
  write(reachability, read(reachability)
    .replace("  'scripts/autonomous-orchestrator-interposer.test.ts',\n", '')
    .replace("  'scripts/autonomous-spawn-budget.test.ts',\n", '')
    .replace("  'scripts/review-pipeline-spawn-budget.test.ts',\n", ''));
}

const residuals = [];
for (const file of trackedFiles()) {
  if (!existsSync(abs(file)) || statSync(abs(file)).isDirectory()) continue;
  if (file.startsWith('docs/issues_drafts/') || file === 'docs/migration_notes.md' || file.startsWith('docs/declarations/')) continue;
  if (file === 'scripts/reachability-purge.manifest.json') continue;
  const buffer = readFileSync(abs(file));
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const marker of ['AO_AUTONOMOUS_ORCHESTRATOR_SURFACE', '.ao/autonomous-real-binaries.json']) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(marker)) residuals.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
}
if (residuals.length > 0) throw new Error(`active retired-surface references remain:\n${residuals.join('\n')}`);
console.log('Issue #821 continuation transform complete.');
