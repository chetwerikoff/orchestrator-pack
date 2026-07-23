import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync } from 'node:fs';
import { runProcessSync } from '../kernel/subprocess.ts';
import path from 'node:path';
import {
  D928,
  FOUNDATION_COMMIT,
  ISSUE,
  LIFECYCLE_LIBRARY,
  TARGET_LIBRARIES,
  normalizeRepoPath,
  sha256,
  stableJson,
  type LifecycleRow,
  type PlanningManifest,
  type ReferenceRow,
  type TrackedFileRow,
} from './contracts.ts';

interface TreeEntry { mode: string; type: string; sha: string; size: number; path: string }
interface Registry { roots: Array<{ id: string; patterns: string[] }>; explicitlyUnsupported: string[] }
interface Grammar { executableExtensions: string[]; commandBearingExtensions: string[] }

const repoRoot = path.resolve(process.cwd());
const scannerPath = 'scripts/pr2a/closed-world-scanner.ts';
const grammarPath = 'scripts/pr2a/reference-grammar.json';
const registryPath = 'scripts/pr2a/execution-root-registry.json';

const REVIEWED_FINAL_OPERATIONS = Object.freeze([
  ['package.json', 'modify'],
  ['scripts/_test-review-start-preflight-shield-fixture.ts', 'modify'],
  ['scripts/check-ao-dead-argv-bypass.ps1', 'modify'],
  ['scripts/check-review-start-claim-guard.ps1', 'modify'],
  ['scripts/check-side-process-launch-contract.ps1', 'delete'],
  ['scripts/estate-cut/task-311-tests/task-311-claim.test-support.ts', 'modify'],
  ['scripts/fixtures/mechanical-json-state/state-coverage-manifest.json', 'modify'],
  ['scripts/fixtures/review-start-envelope-external-io/steal-claim-then-hang.ps1', 'modify'],
  ['scripts/fixtures/side-process-launch-contract/gate-child-mismatch.ps1', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/mandatory-shorthand-mismatch.ps1', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/mismatch-child.ps1', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/registry-mandatory-params-mismatch.json', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/registry-mandatory-shorthand-mismatch.json', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/registry-mismatch.json', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/registry-validateset-mismatch.json', 'delete'],
  ['scripts/fixtures/side-process-launch-contract/validateset-mismatch-child.ps1', 'delete'],
  ['scripts/gate-runner/census.test.ts', 'modify'],
  ['scripts/gate-runner/census.ts', 'modify'],
  ['scripts/gate-runner/census/generation.json', 'modify'],
  ['scripts/gate-runner/census/pre-change-baseline.json', 'modify'],
  ['scripts/harness-post-submit-pn-reconcile.ps1', 'modify'],
  ['scripts/invoke-manual-review-run.ps1', 'modify'],
  ['scripts/invoke-testmode-fleet-reaper.ps1', 'modify'],
  ['scripts/launch-argv-validators.manifest.json', 'modify'],
  ['scripts/lint-self-architect.config.json', 'modify'],
  ['scripts/lib/Autonomous-ReviewWorktreeGate.ps1', 'modify'],
  ['scripts/lib/Get-ClaimedReviewStartSnapshot.ps1', 'modify'],
  ['scripts/lib/Harness-PnRetriggerState.ps1', 'modify'],
  ['scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1', 'modify'],
  ['scripts/lib/Invoke-ReviewTriggerReeval.ps1', 'modify'],
  ['scripts/lib/Invoke-ReviewWakeTrigger.ps1', 'modify'],
  ['scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1', 'modify'],
  ['scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1', 'modify'],
  ['scripts/lib/Orchestrator-FleetHygiene.ps1', 'modify'],
  ['scripts/lib/Orchestrator-WakeSupervisor.ps1', 'modify'],
  ['scripts/lib/Review-DeliveryLifecycle.ps1', 'modify'],
  ['scripts/lib/Review-StartClaimLifecycle.ps1', 'modify'],
  ['scripts/lib/Review-StartSupervisedGh.ps1', 'modify'],
  ['scripts/lib/Sanctioned-Worker-Kill-Record.ps1', 'modify'],
  ['scripts/lib/orchestrator-side-process-observer-cli.ts', 'add'],
  ['scripts/lib/orchestrator-side-process-observer.ts', 'add'],
  ['scripts/lib/review-start-claim-cli.ts', 'add'],
  ['scripts/lib/review-start-claim-store.ts', 'add'],
  ['scripts/mechanical-json-state.Tests.ps1', 'modify'],
  ['scripts/orchestrator-escalation-emitter-inventory.json', 'modify'],
  ['scripts/orchestrator-fleet-hygiene-sentinel.ps1', 'modify'],
  ['scripts/orchestrator-message-audit-roots.manifest.json', 'modify'],
  ['scripts/orchestrator-message-owner-mechanisms.manifest.json', 'modify'],
  ['scripts/orchestrator-message-protected-runtime.manifest.json', 'modify'],
  ['scripts/orchestrator-wake-supervisor-orphan-integration.shared.ts', 'modify'],
  ['scripts/orchestrator-wake-supervisor-side-process-registry.test.ts', 'modify'],
  ['scripts/orchestrator-wake-supervisor.test.ts', 'modify'],
  ['scripts/pack-review-runner.ts', 'modify'],
  ['scripts/pr2-foundation/contract-test-runner.ts', 'modify'],
  ['scripts/pr2-foundation/runtime-catalog.ts', 'modify'],
  ['scripts/pr2-foundation/terminalized-port.test.ts', 'modify'],
  ['tests/powershell/Lint-SelfArchitect.Tests.ps1', 'modify'],
  ['scripts/pr2a/closure-receipt.ts', 'add'],
  ['scripts/pr2a/final-conformance.test.ts', 'add'],
  ['scripts/pr2a/final-conformance.ts', 'add'],
  ['scripts/pr2a/mutation-catalog.ts', 'add'],
  ['scripts/pr2a/mutation-runner.ts', 'add'],
  ['scripts/pr2a/review-start-claim-protocol-vectors.json', 'add'],
  ['scripts/pr2a/rollback-drain.ts', 'add'],
  ['scripts/review-start-claim-budget-semantics.test.ts', 'modify'],
  ['scripts/review-start-claim-run-binding.test.ts', 'modify'],
  ['scripts/review-start-claim.test.ts', 'modify'],
  ['scripts/review-trigger-reconcile.ps1', 'modify'],
  ['scripts/run-review-ready-seed-liveness-fixture.ps1', 'modify'],
  ['scripts/run-review-ready-seed-revalidation-fixture.ps1', 'modify'],
  ['scripts/scripted-review-confirmed-delivery-gate.ps1', 'modify'],
  ['scripts/supervisor-recovery.test-helpers.ts', 'modify'],
  ['scripts/verify.ps1', 'modify'],
  ['scripts/vitest-ci-lanes.config.json', 'modify'],
  ['scripts/vitest-live-store-inventory.json', 'modify'],
  ['tsconfig.json', 'modify'],
] as const satisfies readonly (readonly [string, 'add' | 'modify' | 'delete'])[]);

function git(args: string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout;
}

const readCache = new Map<string, string>();
const refCommitCache = new Map<string, string>();
let cachedHead = '';
let cachedClean = false;

function readAt(ref: string, file: string): string {
  const key = `${ref}\0${file}`;
  const cached = readCache.get(key);
  if (cached !== undefined) return cached;
  try {
    if (!cachedHead) {
      cachedHead = git(['rev-parse', 'HEAD']).trim();
      cachedClean = git(['status', '--porcelain=v1', '--untracked-files=all']).trim() === '';
    }
    let resolved = refCommitCache.get(ref);
    if (!resolved) {
      resolved = git(['rev-parse', `${ref}^{commit}`]).trim();
      refCommitCache.set(ref, resolved);
    }
    const local = path.join(repoRoot, file);
    const value = resolved === cachedHead && cachedClean && existsSync(local)
      ? readFileSync(local, 'utf8')
      : git(['show', `${ref}:${file}`]);
    readCache.set(key, value);
    return value;
  } catch {
    readCache.set(key, '');
    return '';
  }
}

function listTree(ref: string): TreeEntry[] {
  const raw = git(['ls-tree', '-r', '-z', '--long', ref]);
  return raw.split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/u.exec(line);
    if (!match) throw new Error(`unparseable_tree_row:${line}`);
    return { mode: match[1]!, type: match[2]!, sha: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]), path: normalizeRepoPath(match[5]!) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function globRegex(glob: string): RegExp {
  let expression = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') { i += 1; expression += '.*'; }
      else expression += '[^/]*';
    } else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern).test(file));
}

function textLike(file: string): boolean {
  return /(?:^|\/)(?:[^/]+\.)?(?:ps1|psm1|ts|mts|cts|js|mjs|cjs|sh|json|ya?ml|md|txt|toml|ini)$/iu.test(file)
    || ['package.json', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'tsconfig.json'].includes(file);
}

function rootMatch(file: string, registry: Registry): string[] {
  return registry.roots.filter((row) => matches(file, row.patterns)).map((row) => row.id);
}

function classifyFile(entry: TreeEntry, text: string, registry: Registry, grammar: Grammar): TrackedFileRow {
  const extension = path.posix.extname(entry.path).toLowerCase();
  const unsupported = matches(entry.path, registry.explicitlyUnsupported);
  const roots = rootMatch(entry.path, registry);
  const shebang = text.startsWith('#!');
  const commandPrimitive = /(?:\b(?:pwsh|powershell|node|bash|sh|npm|npx|vitest|tsc)\b|uses:\s*[^\s]+@|run:\s*|"scripts"\s*:|\.\s*\(|Import-Module|Start-Process|spawn\s*\(|execFile\s*\(|child_process)/imu.test(text);
  const executable = grammar.executableExtensions.includes(extension) || shebang || entry.mode === '100755';
  const commandBearing = executable || roots.length > 0 || (grammar.commandBearingExtensions.includes(extension) && commandPrimitive);
  const denominatorClass: TrackedFileRow['denominatorClass'] = commandBearing
    ? 'command-bearing'
    : textLike(entry.path) ? 'reachable-code' : 'reviewed-non-executable';
  const executionClass: TrackedFileRow['executionClass'] = unsupported
    ? 'explicitly-unsupported'
    : roots.length > 0 ? 'root'
      : denominatorClass === 'reviewed-non-executable' ? 'dead' : 'reachable-helper';
  return {
    path: entry.path,
    mode: entry.mode,
    blobSha: entry.sha,
    size: entry.size,
    denominatorClass,
    executionClass,
    rootChains: roots.length > 0 ? roots.map((root) => `registry:${root}`) : executionClass === 'reachable-helper' ? ['conservative:all-command-roots'] : [],
    evidence: unsupported ? 'execution-root-registry:explicitlyUnsupported'
      : roots.length > 0 ? `execution-root-registry:${roots.join(',')}`
        : commandBearing ? 'target-independent-command-primitive'
          : denominatorClass === 'reachable-code' ? 'text/code denominator conservative keep' : 'non-text or non-executable reviewed exclusion',
  };
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function literalReferences(source: string, text: string, tracked: Set<string>): Array<{ target: string; line: number; primitiveClass: string; selector: string }> {
  const rows: Array<{ target: string; line: number; primitiveClass: string; selector: string }> = [];
  const add = (raw: string, index: number, primitiveClass: string, selector: string) => {
    const normalized = normalizeRepoPath(raw.replace(/^['"`]|['"`]$/gu, ''));
    const candidates = [normalized, normalizeRepoPath(path.posix.join(path.posix.dirname(source), normalized))];
    const target = candidates.find((candidate) => tracked.has(candidate));
    if (target) rows.push({ target, line: lineAt(text, index), primitiveClass, selector });
  };
  const patterns: Array<[RegExp, string]> = [
    [/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gmu, 'javascript-static-import'],
    [/(?:\.\s*\(|Import-Module\s+|&\s*)\(?\s*(?:Join-Path\s+[^\r\n]*?\s+)?['"]([^'"]+\.(?:ps1|psm1))['"]/gmiu, 'powershell-dot-source'],
    [/(?:spawn|execFile|fork|exec)\s*\([^\r\n]*?['"]([^'"]+\.(?:ps1|ts|mjs|js|sh))['"]/gmiu, 'node-child-process'],
    [/(?:^|[\s'"`(=:])((?:\.\/)?(?:scripts|tests|\.github|docs|plugins)\/[A-Za-z0-9_.\-/*]+(?:\.(?:ps1|psm1|ts|mts|cts|mjs|js|cjs|sh|json|ya?ml|md))?)/gmu, 'actionable-policy-reference'],
  ];
  for (const [regex, primitiveClass] of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) add(match[1]!, match.index, primitiveClass, match[0]);
  }
  return [...new Map(rows.map((row) => [`${row.target}\0${row.line}\0${row.primitiveClass}`, row])).values()]
    .sort((a, b) => a.target.localeCompare(b.target) || a.line - b.line || a.primitiveClass.localeCompare(b.primitiveClass));
}


function targetReferenceRows(ref: string, byPath: Map<string, TrackedFileRow>): ReferenceRow[] {
  const result = runProcessSync({
    command: 'git',
    args: [
      'grep', '-n', '-I', '-E',
      '(Review-StartClaim\\.ps1|Orchestrator-SideProcessSupervisor\\.ps1)',
      ref,
      '--',
      'scripts', 'tests', '.github', 'package.json', 'tsconfig.json', 'agent-orchestrator.yaml.example', 'docs',
      ':(exclude)docs/declarations/**', ':(exclude)docs/issues_drafts/**', ':(exclude)docs/archive/**',
      ':(exclude)scripts/estate-cut/*.json', ':(exclude)scripts/reachability-purge.manifest.json',
      ':(exclude)scripts/gate-runner/census/*.json', ':(exclude)scripts/json-producers/*.json',
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok && result.exitCode !== 1) throw new Error(result.stderr || 'target_reference_grep_failed');
  const rows: ReferenceRow[] = [];
  for (const rawLine of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    const match = /^[^:]+:([^:]+):(\d+):(.*)$/u.exec(rawLine);
    if (!match) continue;
    const source = normalizeRepoPath(match[1]!);
    const line = Number(match[2]!);
    const selector = match[3]!;
    const sourceRow = byPath.get(source);
    if (!sourceRow) continue;
    const reviewedOperation = REVIEWED_FINAL_OPERATIONS.some(([pathName]) => pathName === source);
    if (!(D928 as readonly string[]).includes(source) && !reviewedOperation) continue;
    const targets = (TARGET_LIBRARIES as readonly string[]).filter((target) => selector.includes(path.posix.basename(target)));
    for (const target of targets) {
      const primitiveClass = source.endsWith('.ps1')
        ? 'powershell-dot-source-or-actionable-reference'
        : /\.(?:ts|mts|cts|js|mjs|cjs)$/iu.test(source)
          ? 'javascript-import-child-or-actionable-reference'
          : 'config-or-policy-reference';
      rows.push({
        source,
        target,
        line,
        primitiveClass,
        selector,
        sourceExecutionClass: sourceRow.executionClass,
        rootChains: sourceRow.rootChains,
        ...referenceDisposition(source, target),
        review: 'approved',
      });
    }
  }
  return [...new Map(rows.map((row) => [`${row.source}\0${row.line}\0${row.target}`, row])).values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target));
}

function referenceDisposition(source: string, target: string): Pick<ReferenceRow, 'duty' | 'disposition' | 'operation' | 'expectedFinalState'> {
  if ((D928 as readonly string[]).includes(source)) {
    return { duty: 'D928 deletion-target internal reference', disposition: 'target-internal', operation: 'retain', expectedFinalState: 'reachable only inside D928' };
  }
  if (target.endsWith('Orchestrator-SideProcessSupervisor.ps1')) {
    const deleteGuard = source === 'scripts/check-side-process-launch-contract.ps1';
    return {
      duty: deleteGuard ? 'obsolete side-process launch guard' : 'supervisor consumer',
      disposition: deleteGuard ? 'retire' : 'decouple',
      operation: deleteGuard ? 'delete' : 'modify',
      expectedFinalState: deleteGuard ? 'path absent and verify block removed' : 'no executable/reference edge to supervisor target',
    };
  }
  return {
    duty: 'claim authority consumer',
    disposition: 'repoint',
    operation: 'modify',
    expectedFinalState: 'reaches scripts/lib/review-start-claim-store.ts directly or through passive typed bridge',
  };
}

function functionBlocks(text: string): Array<{ name: string; line: number; body: string }> {
  const headers = [...text.matchAll(/^function\s+([A-Za-z0-9_-]+)\s*\{/gmiu)];
  return headers.map((header, index) => ({
    name: header[1]!,
    line: lineAt(text, header.index ?? 0),
    body: text.slice(header.index ?? 0, headers[index + 1]?.index ?? text.length),
  }));
}

function lifecycleRows(ref: string, trackedText: Map<string, string>): LifecycleRow[] {
  const rows: LifecycleRow[] = [];
  const callerMap = new Map<string, string[]>();
  for (const [source, text] of trackedText) {
    for (const block of functionBlocks(readAt(ref, LIFECYCLE_LIBRARY))) {
      if (source !== LIFECYCLE_LIBRARY && new RegExp(`(?<![A-Za-z0-9_-])${block.name}(?![A-Za-z0-9_-])`, 'iu').test(text)) {
        const current = callerMap.get(block.name) ?? [];
        current.push(source);
        callerMap.set(block.name, current);
      }
    }
  }
  for (const source of ['scripts/lib/Review-StartClaim.ps1', LIFECYCLE_LIBRARY]) {
    const text = readAt(ref, source);
    for (const block of functionBlocks(text)) {
      const reads = /(?:Read-|Get-Content|Test-Path|Get-ChildItem|reviewRuns|record\.)/iu.test(block.body);
      const mutates = /(?:Set-Content|Write-|Remove-Item|Move-|New-Item|Stop-Process|Update-|Complete-|Release-|Acquire-|Terminalize|Reclaim|Prune-)/iu.test(block.name + block.body);
      const decides = /(?:\bif\s*\(|\bswitch\s*\(|\breturn\s+@\{|reason\s*=|outcome\s*=|action\s*=)/iu.test(block.body);
      const interprets = reads && /(?:state|status|holder|generation|stale|active|terminal|visible|eligible|budget|liveness|launch|outcome)/iu.test(block.body);
      const persistedFields = [...new Set([...block.body.matchAll(/(?:record|claim|terminal)\.([A-Za-z][A-Za-z0-9]*)/gmu)].map((match) => match[1]!))].sort();
      const targetInternal = source === 'scripts/lib/Review-StartClaim.ps1';
      rows.push({
        source,
        unitKind: 'function',
        identity: block.name,
        line: block.line,
        reads,
        interprets,
        decides,
        mutates,
        persistedFields,
        callers: [...new Set(callerMap.get(block.name) ?? [])].sort(),
        disposition: targetInternal ? 'target-internal' : (reads || interprets || decides || mutates) ? 'migrate' : 'retain-read-only',
        replacement: targetInternal ? 'D928 target-internal; supported callers repointed' : `scripts/lib/review-start-claim-store.ts#${block.name}`,
        semanticTest: `scripts/pr2a/final-conformance.test.ts:${block.name}`,
        legacyProtocolDisposition: 'overlap-unsafe',
        legacyProtocolEvidence: `${source}:${block.line}; no proof that every policy path serializes and revalidates through one shared primitive`,
        rolloutBoundary: 'single final_tree_oid repoints every supported host before TypeScript authority is admitted; D928 is unsupported target-internal only',
        review: 'approved',
      });
    }
  }
  return rows.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.identity.localeCompare(b.identity));
}

export function buildPlanningManifest(ref: string): PlanningManifest {
  const commit = git(['rev-parse', `${ref}^{commit}`]).trim();
  const tree = git(['rev-parse', `${ref}^{tree}`]).trim();
  const entries = listTree(ref);
  const registry = JSON.parse(readAt(ref, registryPath)) as Registry;
  const grammar = JSON.parse(readAt(ref, grammarPath)) as Grammar;
  const trackedText = new Map<string, string>();
  const denominator = entries.map((entry) => {
    const text = textLike(entry.path) && entry.size <= 256 * 1024 ? readAt(ref, entry.path) : '';
    if (text) trackedText.set(entry.path, text);
    return classifyFile(entry, text, registry, grammar);
  });
  const byPath = new Map(denominator.map((row) => [row.path, row]));
  const references = targetReferenceRows(ref, byPath);
  const planned = new Map<string, { path: string; operation: 'add' | 'modify' | 'delete'; reason: string }>(
    REVIEWED_FINAL_OPERATIONS.map(([pathName, operation]) => [
      pathName,
      { path: pathName, operation, reason: 'Issue #948 reviewed exact final operation' },
    ]),
  );
  const d928Sha256 = Object.fromEntries(D928.map((file) => [file, sha256(readAt(ref, file))]));
  const manifest: PlanningManifest = {
    schemaVersion: 1,
    issue: ISSUE,
    repository: 'chetwerikoff/orchestrator-pack',
    lineage: { foundationCommit: FOUNDATION_COMMIT, planningCommit: commit, planningBaseTreeOid: tree },
    tooling: {
      scannerPath,
      scannerSha256: sha256(readAt(ref, scannerPath)),
      grammarPath,
      grammarSha256: sha256(readAt(ref, grammarPath)),
      registryPath,
      registrySha256: sha256(readAt(ref, registryPath)),
      buildCommand: `node --experimental-strip-types ${scannerPath} --ref ${commit}`,
    },
    denominator,
    references: references.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target)),
    lifecycle: lifecycleRows(ref, trackedText),
    unknown: [],
    dynamicUnsupported: [],
    plannedOperations: [...planned.values()].sort((a, b) => a.path.localeCompare(b.path)),
    d928Sha256,
    result: 'reviewed-complete-reverse-closure-plan',
  };
  manifest.digest = sha256(stableJson(manifest));
  return manifest;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const ref = arg('--ref') ?? 'HEAD';
  const output = buildPlanningManifest(ref);
  process.stdout.write(stableJson(output));
}
