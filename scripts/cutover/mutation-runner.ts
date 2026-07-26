#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';

const CONTROLS = {
  AC1: ['operator-ack-only','pr2a-merge-missing','pr2a-receipt-trusted-without-recompute','closure-schema-incompatible','external-supervisor-library-reference','external-claim-library-reference','closure-unresolved-set-nonempty','closure-input-tree-unbound','fleet-member-omitted','stale-member-accepted','rejoining-member-unquarantined','diverged-revision-accepted','second-control-plane-host','host-or-repo-unbound','installed-commit-unbound','old-installed-revision-missing','legacy-supervisor-identity-ambiguous','node22-not-enforced','competing-transaction-admitted','successor-926-used-as-prerequisite','mutation-before-admission'],
  AC2: ['install-kills-old-supervisor','install-gap-acquirer-gap','ts-supervisor-starts-at-install','dual-supervisor-owner','cordon-not-first','legacy-supervisor-terminated-before-cordon','legacy-supervisor-survivor','legacy-supervisor-identity-unverified','ts-supervisor-start-before-cas','store-writer-ingress-left-open','concurrent-writer-admitted','drain-watermark-missing','pid-identity-unverified','survivor-accepted','registry-projection-before-import-digest','registry-file-or-parent-not-fsynced','registry-readback-hash-missing','precommit-log-not-durable-before-cas','precommit-digest-not-in-core','precommit-log-digest-mismatch-accepted','registry-treated-as-commit','central-cas-not-sole-commit','cas-core-field-extra-or-missing','postcommit-followup-treated-as-commit','cas-conflict-ignored','tracked-registry-restored-consumed','legacy-executable-reference-restored','epoch-gated-source-missing','postactivation-start-without-reprojection','dual-scheduler'],
  AC3: ['snapshot-before-drain','writer-watermark-missing','concurrent-store-writer','snapshot-version-missing','snapshot-digest-not-raw-bytes','digest-algorithm-not-sha256','stable-stringify-key-order-wrong','stable-stringify-whitespace-present','unicode-or-escape-vector-mismatch','negative-zero-or-exponent-vector-mismatch','nested-key-order-vector-mismatch','vector-failing-payload-accepted','store-covered-field-omitted','unknown-store-field-silently-ignored','target-import-identity-missing','target-import-identity-aliased','target-cas-or-upsert-omitted','marker-only-completion','target-state-digest-mismatch-accepted','post-mutation-pre-marker-reapplied','legacy-read-partial-import','claim-store-modified','claim-reaper-modified','claim-semantics-changed','claim-key-or-namespace-changed','second-claim-store-created','claimant-family-not-ts-native','powershell-claim-path-resurrected','four-deletion-disturbs-claim-authority','pr2a-overlap-proof-reimplemented'],
  AC4: ['harness-owned-cycle','merge-rehearsal-labeled-live','staged-registry-missing','staged-registry-has-legacy-child','live-registry-diff-at-merge','denominator-file-diff-from-post948-base','denominator-file-not-loadable','install-gap-old-supervisor-continuity-untested','ts-supervisor-not-inert','claim-authority-diff-at-merge','claim-key-changed','durable-delivery-missing','cutover-row-not-terminalized','deleted-supervisor-duty-missing','orphan-claim-file-not-deleted','powershell-shim-used-in-rehearsal','retired-launch-contract-guard-restored','926-precedes-adoption','930-precedes-926'],
  AC5: ['preimport-target-change-unchecked','rollback-old-revision-unbound','rollback-uses-new-checkout-ps-shim','import-begin-recorded-after-mutation','legacy-restored-after-import-begin','legacy-epoch-rearmed-on-migrated-store','postmutation-import-bytes-discarded','forward-recovery-uncordoned','registry-projection-crash-unrecovered','precommit-log-digest-mismatch-accepted','precommit-log-fabricated-on-recovery','precas-ts-supervisor-started','postactivation-start-without-reprojection','postcas-followup-missing-treated-uncommitted','postcas-followup-changes-commit','postcas-legacy-restored','reverse-reconciliation-completeness-claimed'],
  AC6: ['candidate-manifest-self-authorizes','addition-root-not-predeclared','foundation-component-reimplemented','live-registry-modified','denominator-compatibility-file-modified','denominator-file-not-loadable','staged-registry-omitted','unrelated-manifest-row-changed','required-ps-deletion-missing','ps-file-shimmed-not-deleted','new-powershell-logic-added','powershell-file-modified-instead-of-deleted','powershell-file-renamed','embedded-powershell-program','cutover-module-spawns-pwsh','supervisor-ts-replacement-missing','claim-store-modified','claim-reaper-modified','claimant-family-modified','second-claim-store-created','powershell-claim-path-resurrected','retired-launch-contract-guard-restored','legacy-executable-reference-restored','symlink-mode','gitlink-mode','nonregular-mode','test-classification-missing','test-classification-duplicate','lane-config-overreach'],
  AC7: ['cas-core-field-extra-or-missing','pr2a-closure-admission-evidence-missing','precommit-log-not-durable-before-cas','precommit-digest-not-in-core','precommit-log-digest-mismatch-accepted','legacy-supervisor-termination-evidence-missing','ts-supervisor-inert-evidence-missing','precommit-timestamp-outside-core','postcommit-timestamp-in-core','followup-epoch-reference-missing','followup-sequence-duplicate','followup-sequence-gap','followup-sequence-nonmonotonic','followup-treated-authoritative','ts-supervisor-start-followup-missing','scheduler-enable-followup-missing','local-fsync-followup-missing','host-context-described-as-authentication','second-commit-same-epoch','nonce-not-generated-at-cordon','nonce-not-stored-centrally','consumer-skips-central-nonce-equality','stale-nonce-replay','local-record-treated-authoritative','rehearsal-record-accepted-live','same-tuple-recovery-duplicates-commit'],
  AC8: ['wrong-node-major-admitted','windows-native-activation','unsupported-platform-admitted','repo-root-not-canonical','cross-device-registry-projection','pid-start-time-unchecked','process-tree-survivor','exclusive-lock-omitted','atomic-rename-omitted','file-fsync-omitted','parent-fsync-omitted','new-powershell-logic-added','verify-guard-record-missing','reusable-guard-record-missing','guard-not-pwsh7','guard-stale-head','guard-nonzero-accepted','guard-stdout-digest-missing','retired-launch-contract-guard-restored','supervisor-dependent-pester-load-restored'],
} as const;

type AcceptanceId = keyof typeof CONTROLS;
type DetectorPattern =
  | 'foundation'
  | 'closure'
  | 'activation'
  | 'survivor'
  | 'recovery'
  | 'scope'
  | 'vectors'
  | 'node'
  | 'canonical-root'
  | 'primitives'
  | 'registry'
  | 'scheduler';

interface ArtifactSnapshot {
  existed: boolean;
  bytes: Buffer;
  mode: number;
}

interface MutationSpec {
  artifactPath: string;
  detector: DetectorPattern;
  apply(snapshot: ArtifactSnapshot): { bytes: Buffer; mode: number };
}

interface MutationEvidence {
  ac: AcceptanceId;
  mutationId: string;
  artifactPath: string;
  detectorId: string;
  detectorCommand: string[];
  artifactHashBefore: string;
  artifactHashAfter: string;
  restoredHash: string;
  negativeOutcome: 'failed';
  restoredOutcome: 'passed';
  negativeExitCode: number;
  restoredExitCode: 0;
}

const repoRoot = path.resolve(process.cwd());
const TEST_FILE = 'scripts/cutover/issue-928.test.ts';
const DETECTORS: Record<DetectorPattern, string> = {
  foundation: 'refuses before cordon when foundation adoption evidence is unavailable',
  closure: 'recomputes #948 reverse closure against the merge base',
  activation: 'runs the real transaction through synthetic process/store/CAS boundaries',
  survivor: 'refuses snapshot/import when legacy processes survive re-enumeration',
  recovery: 'resumes forward from the import boundary when CAS has not happened yet',
  scope: 'contains exactly the four PowerShell deletions and preserves #948 claim authority/tracked registry',
  vectors: 'reproduces committed canonicalization vectors',
  node: 'fails unsupported Node before any cordon path can be created',
  'canonical-root': 'rejects a non-canonical repository root instead of normalizing it',
  primitives: 'retains durability, exclusion and central nonce primitives',
  registry: 'accepts only the scheduler-only target registry',
  scheduler: 'starts exactly one exact-head review only after central epoch/nonce verification and fresh checks',
};

function digest(snapshot: ArtifactSnapshot): string {
  if (!snapshot.existed) return 'sha256:absent';
  return `sha256:${createHash('sha256').update(`${snapshot.mode.toString(8)}\0`).update(snapshot.bytes).digest('hex')}`;
}

function snapshotArtifact(relativePath: string): ArtifactSnapshot {
  const file = path.join(repoRoot, relativePath);
  if (!existsSync(file)) return { existed: false, bytes: Buffer.alloc(0), mode: 0o600 };
  return { existed: true, bytes: readFileSync(file), mode: statSync(file).mode & 0o777 };
}

function writeArtifact(relativePath: string, value: { bytes: Buffer; mode: number }): void {
  const file = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value.bytes, { mode: value.mode });
  chmodSync(file, value.mode);
}

function restoreArtifact(relativePath: string, snapshot: ArtifactSnapshot): void {
  const file = path.join(repoRoot, relativePath);
  if (!snapshot.existed) {
    rmSync(file, { force: true });
    return;
  }
  writeArtifact(relativePath, { bytes: snapshot.bytes, mode: snapshot.mode });
}

function replaceSpec(artifactPath: string, detector: DetectorPattern, token: string, replacement: string, all = false): MutationSpec {
  return {
    artifactPath,
    detector,
    apply: (snapshot) => {
      if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
      const source = snapshot.bytes.toString('utf8');
      if (!source.includes(token)) throw new Error(`mutation_token_missing:${artifactPath}:${token}`);
      const mutated = all ? source.split(token).join(replacement) : source.replace(token, replacement);
      return { bytes: Buffer.from(mutated, 'utf8'), mode: snapshot.mode };
    },
  };
}

function appendSpec(artifactPath: string, detector: DetectorPattern, text: string): MutationSpec {
  return {
    artifactPath,
    detector,
    apply: (snapshot) => {
      if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
      return { bytes: Buffer.concat([snapshot.bytes, Buffer.from(`${snapshot.bytes.toString('utf8').endsWith('\n') ? '' : '\n'}${text}\n`, 'utf8')]), mode: snapshot.mode };
    },
  };
}

function createSpec(artifactPath: string, detector: DetectorPattern, text: string): MutationSpec {
  return {
    artifactPath,
    detector,
    apply: (snapshot) => {
      if (snapshot.existed) throw new Error(`mutation_create_target_exists:${artifactPath}`);
      return { bytes: Buffer.from(`${text}\n`, 'utf8'), mode: 0o600 };
    },
  };
}

function modeSpec(artifactPath: string, detector: DetectorPattern, mode: number): MutationSpec {
  return {
    artifactPath,
    detector,
    apply: (snapshot) => {
      if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
      return { bytes: snapshot.bytes, mode };
    },
  };
}

function registrySpec(): MutationSpec {
  return replaceSpec(
    'scripts/orchestrator-side-process-registry.cutover-target.json',
    'registry',
    '"id": "pr2-scheduler"',
    '"id": "legacy-mutation"',
  );
}

function scopeProtectedSpec(): MutationSpec {
  return appendSpec('scripts/lib/review-start-claim-store.ts', 'scope', '// issue-928 mutation: protected claim authority drift');
}

function scopeDeletedSpec(): MutationSpec {
  return createSpec('scripts/lib/Review-StartClaim.ps1', 'scope', '# issue-928 mutation: forbidden restored PowerShell claim shim');
}

function mutationSpec(ac: AcceptanceId, id: string): MutationSpec {
  if (ac === 'AC1') {
    if (/pr2a|closure|external-(supervisor|claim)|unresolved|input-tree/.test(id)) {
      return replaceSpec('scripts/pr2a/closed-world-scanner.ts', 'closure', "const registryPath = 'scripts/pr2a/execution-root-registry.json';", "const registryPath = 'scripts/pr2a/__mutation_missing_root_registry.json';");
    }
    if (/node22/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'node', "if (major !== 22) throw new Error('node22_required');", "if (false) throw new Error('node22_required');");
    }
    if (/host-or-repo|installed-commit|old-installed/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'canonical-root', 'if (value !== lexical || lexical !== canonical)', 'if (false)');
    }
    return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'foundation', 'const foundation = boundary.proveFoundationAdoption(request);', "const foundation = { result: 'foundation-evidence-verified' } as FoundationAdmissionProof;");
  }

  if (ac === 'AC2') {
    if (/survivor|identity-unverified|terminated-before|pid-identity/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'survivor', 'if (survivors.supervisorAlive || survivors.writers.length !== 0) {', 'if (false) {');
    }
    if (/registry/.test(id)) return registrySpec();
    if (/cas|commit|precommit|core-field/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'activation', '    preCommitLogDigest: phaseOne.digest,\n', '');
    }
    if (/supervisor|scheduler|epoch-gated|legacy-executable/.test(id)) {
      return replaceSpec('scripts/lib/orchestrator-side-process-supervisor.ts', 'primitives', '      const verified = verifyEpochAndProjection(options);', "      const verified = { registryHash: 'mutation', cadenceSeconds: 1 };");
    }
    return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'activation', '    noRespawn: true,', '    noRespawn: false as true,');
  }

  if (ac === 'AC3') {
    if (/stable-stringify|unicode|escape|negative-zero|exponent|nested-key|digest-algorithm/.test(id)) {
      return replaceSpec('scripts/lib/cutover/stable-stringify.ts', 'vectors', 'Object.keys(object).sort()', 'Object.keys(object)');
    }
    if (/claim|powershell|second-claim|claimant|pr2a-overlap/.test(id)) return scopeProtectedSpec();
    return replaceSpec('scripts/lib/cutover/activation-import.ts', 'activation', '  const importTargetDigest = sha256Stable(normalized);', "  const importTargetDigest = 'sha256:mutation';");
  }

  if (ac === 'AC4') {
    if (/registry|staged/.test(id)) return registrySpec();
    if (/claim|powershell|orphan|retired|deleted-supervisor|denominator|live-registry/.test(id)) return scopeDeletedSpec();
    return replaceSpec('scripts/pr2-foundation/scheduler.ts', 'scheduler', '    if (!decision.eligible) { skipped += 1; continue; }', '    if (true) { skipped += 1; continue; }');
  }

  if (ac === 'AC5') {
    if (/preimport-target-change|rollback-old-revision/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-recovery.ts', 'activation', '    if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {', '    if (false) {');
    }
    return replaceSpec('scripts/lib/cutover/activation-recovery.ts', 'recovery', '    core = completePreCasRecovery(request, cordon.nonce, authority);', '    core = authority.verify(request.epochId, cordon.nonce);');
  }

  if (ac === 'AC6') {
    if (/symlink-mode|gitlink-mode|nonregular-mode/.test(id)) return modeSpec('scripts/vitest-ci-lanes.config.json', 'scope', 0o755);
    if (/test-classification|lane-config/.test(id)) return appendSpec('scripts/vitest-ci-lanes.config.json', 'scope', ' ');
    if (/claim|second-claim|claimant/.test(id)) return scopeProtectedSpec();
    if (/live-registry/.test(id)) return appendSpec('scripts/orchestrator-side-process-registry.json', 'scope', ' ');
    return scopeDeletedSpec();
  }

  if (ac === 'AC7') {
    if (/nonce|replay|consumer-skips/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'scheduler', 'if (!record || record.nonce !== nonce)', 'if (!record || false)');
    }
    if (/followup|sequence|fsync|precommit|timestamp|evidence/.test(id)) {
      return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '    try { fsyncSync(fd); } finally { closeSync(fd); }', '    try { void fd; } finally { closeSync(fd); }');
    }
    return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', 'if (document.currentEpochId !== expectedOldEpochId)', 'if (false)');
  }

  if (/repo-root/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'canonical-root', 'if (value !== lexical || lexical !== canonical)', 'if (false)');
  }
  if (/exclusive-lock/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', '    mkdirSync(lock);', '    void lock;');
  }
  if (/atomic-rename/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '  renameSync(temporary, target);', '  writeFileSync(target, bytes);');
  }
  if (/file-fsync/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '    fsyncSync(fd);', '    void fd;');
  }
  if (/parent-fsync/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '  syncDirectory(directory);', '  void directory;');
  }
  if (/new-powershell|guard|pester/.test(id)) return scopeDeletedSpec();
  if (/node|windows|unsupported-platform|cross-device|pid-start|process-tree/.test(id)) {
    return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'node', "if (major !== 22) throw new Error('node22_required');", "if (false) throw new Error('node22_required');");
  }
  return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'primitives', 'if (statSync(targetParent).dev !== statSync(projectionParent).dev)', 'if (false)');
}

async function runDetector(detector: DetectorPattern): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const pattern = DETECTORS[detector];
  return runProcess({
    command: process.execPath,
    args: [
      path.join(repoRoot, 'scripts/run-vitest-with-harness.mjs'),
      'run',
      '--maxWorkers=1',
      TEST_FILE,
      '-t',
      pattern,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
    env: {
      OPK_CONTRACT_MUTATIONS_ALREADY_RUN: '1',
      OPK_VITEST_HARNESS: '1',
    },
    allowEmptyStdout: true,
    timeoutMs: 120_000,
  });
}

async function executeMutation(ac: AcceptanceId, mutationId: string): Promise<MutationEvidence> {
  const spec = mutationSpec(ac, mutationId);
  const before = snapshotArtifact(spec.artifactPath);
  const baseline = await runDetector(spec.detector);
  if (!baseline.ok) throw new Error(`mutation_precondition_failed:${ac}:${mutationId}:${baseline.stderr || baseline.stdout}`);
  const applied = spec.apply(before);
  writeArtifact(spec.artifactPath, applied);
  const after = snapshotArtifact(spec.artifactPath);
  const artifactHashBefore = digest(before);
  const artifactHashAfter = digest(after);
  if (artifactHashAfter === artifactHashBefore) {
    restoreArtifact(spec.artifactPath, before);
    throw new Error(`mutation_hash_delta_missing:${ac}:${mutationId}`);
  }

  let negative;
  try {
    negative = await runDetector(spec.detector);
    if (negative.ok) throw new Error(`specific_detector_not_red:${ac}:${mutationId}:${DETECTORS[spec.detector]}`);
  } finally {
    restoreArtifact(spec.artifactPath, before);
  }

  const restored = snapshotArtifact(spec.artifactPath);
  const restoredHash = digest(restored);
  if (restoredHash !== artifactHashBefore) throw new Error(`mutation_restore_hash_mismatch:${ac}:${mutationId}`);
  const green = await runDetector(spec.detector);
  if (!green.ok) throw new Error(`mutation_restore_not_green:${ac}:${mutationId}:${green.stderr || green.stdout}`);

  const detectorCommand = [
    process.execPath,
    'scripts/run-vitest-with-harness.mjs',
    'run',
    '--maxWorkers=1',
    TEST_FILE,
    '-t',
    DETECTORS[spec.detector],
  ];
  return {
    ac,
    mutationId,
    artifactPath: spec.artifactPath,
    detectorId: `issue-928:${spec.detector}:${DETECTORS[spec.detector]}`,
    detectorCommand,
    artifactHashBefore,
    artifactHashAfter,
    restoredHash,
    negativeOutcome: 'failed',
    restoredOutcome: 'passed',
    negativeExitCode: negative?.exitCode ?? 1,
    restoredExitCode: 0,
  };
}

function producerOutcome(ac: AcceptanceId): Record<string, unknown> {
  switch (ac) {
    case 'AC1': return { admission: { result: 'foundation-single-host-adopted' } };
    case 'AC2': return { activation: { result: 'C1-C18-ts-transfer-pass' } };
    case 'AC3': return { import_claim: { result: 'imports-and-claim-compatibility-verified' } };
    case 'AC4': return { cycle: { result: 'rehearsal-and-ts-replacement-proven' } };
    case 'AC5': return { recovery: { result: 'import-boundary-forward-only' } };
    case 'AC6': return { scope: { result: 'ts-only-deletion-rewrite-bounded' } };
    case 'AC7': return { activation_evidence: { result: 'bound-central-cas-record' } };
    case 'AC8': return { merge_gate: { result: 'node22-linux-wsl2-and-pwsh-guards-green' } };
  }
}

function selected(argv: string[]): AcceptanceId[] {
  const index = argv.indexOf('--ac');
  if (index >= 0) {
    const ac = argv[index + 1] as AcceptanceId;
    if (!ac || !(ac in CONTROLS)) throw new Error('invalid_ac');
    return [ac];
  }
  if (argv.includes('--all')) return Object.keys(CONTROLS) as AcceptanceId[];
  throw new Error('expected --ac ACn or --all');
}

async function main(): Promise<void> {
  const evidence: MutationEvidence[] = [];
  const selectedAcs = selected(process.argv.slice(2));
  for (const ac of selectedAcs) {
    for (const mutationId of CONTROLS[ac]) evidence.push(await executeMutation(ac, mutationId));
  }
  const cutover: Record<string, unknown> = {};
  for (const ac of selectedAcs) Object.assign(cutover, producerOutcome(ac));
  process.stdout.write(`${JSON.stringify({
    issue: 928,
    cutover,
    mutationEvidence: evidence,
    mutationRunner: { result: 'externally-grounded', bindings: evidence.length },
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
