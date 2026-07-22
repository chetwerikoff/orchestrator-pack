import {
  buildBoundedSemanticMutation,
  type BoundedSemanticMutation,
} from './mutation-semantic-gates.ts';

interface TextRecipe {
  anchor: string;
  replacement: string;
  artifactPath?: string;
}

const EXECUTABLE_RECIPES: Readonly<Record<string, TextRecipe>> = Object.freeze({
  'AC1:scheduler-acquirer-running': {
    anchor: '    running: false,\n    claimAcquirer: false,',
    replacement: '    running: true,\n    claimAcquirer: false,',
  },
  'AC1:activation-epoch-enforced': {
    anchor: '    activationEpochEnforced: false,\n    pollIntervalMs:',
    replacement: '    activationEpochEnforced: true,\n    pollIntervalMs:',
  },
  'AC1:dormant-config-reader-live': {
    anchor: '    running: false,\n    claimAcquirer: false,',
    replacement: "    running: process.env.OPK_PR2_FOUNDATION_SCHEDULER_RUNNING === '1',\n    claimAcquirer: false,",
  },
  'AC1:notification-config-reader-absent': {
    anchor: 'config = notificationConfig(options.foundationConfig ?? {});',
    replacement: 'config = notificationConfig({});',
  },
  'AC2:capture-metadata-secret-scan-omitted': {
    anchor: "if (forbidden.some((pattern) => pattern.test(text))) return 'capture_metadata_secret_scan_failed';",
    replacement: "if (false) return 'capture_metadata_secret_scan_failed';",
  },
  'AC2:schema-shape-changed': {
    anchor: "  'updatedAt',\n] as const",
    replacement: "  'updatedAt',\n  'branch',\n] as const",
  },
  'AC2:hypothetical-prs-or-branch-trust': {
    anchor: 'return forms.some((pattern) => pattern.test(normalized));',
    replacement: 'return true;',
  },
  'AC2:preflight-missing': {
    anchor: "if (input.command !== 'ao session ls --json') return { ok: false, reason: 'preflight_command_mismatch' };",
    replacement: "if (false) return { ok: false, reason: 'preflight_command_mismatch' };",
  },
  'AC2:preflight-empty-fleet-accepted': {
    anchor: 'if (!Array.isArray(input.sessions) || input.sessions.length === 0) {',
    replacement: 'if (false) {',
  },
  'AC2:preflight-version-unverifiable-accepted': {
    anchor: 'if (input.appStateVersion !== VERIFIED_AO_VERSION)',
    replacement: 'if (false)',
  },
  'AC2:ambiguous-live-issue-index-zero': {
    anchor: 'const ambiguous = eligible.length > 1;',
    replacement: 'const ambiguous = false;',
  },
  'AC2:pr-body-reference-trusted': {
    anchor: 'return forms.some((pattern) => pattern.test(normalized));',
    replacement: "return forms.some((pattern) => pattern.test(normalized)) || normalized.includes(`Closes #${issueId}`);",
  },
  'AC2:draft-candidate-accepted': {
    anchor: '!row.isDraft && ',
    replacement: '',
  },
  'AC2:missing-draft-bit-accepted': {
    anchor: "typeof value.isDraft !== 'boolean'",
    replacement: 'false',
  },
  'AC2:zero-candidate-bound': {
    anchor: "    if (eligible.length === 0) {\n      return {\n        bound: false,\n        classId: 'B1',\n        sessionId: session.id,\n        reason: 'no_source',\n        ...(rejectedCache ? { context: { rejectedCache } } : {}),\n      };\n    }",
    replacement: "    if (eligible.length === 0) {\n      return {\n        bound: true,\n        classId: 'B2',\n        sessionId: session.id,\n        prNumber: 0,\n        currentHeadSha: '0'.repeat(40),\n        source: 'issue_correlation',\n        boundAt: now,\n      };\n    }",
  },
  'AC2:multiple-candidates-bound': {
    anchor: 'const ambiguous = eligible.length > 1;',
    replacement: 'const ambiguous = false;',
  },
  'AC2:bound-head-not-recorded': {
    anchor: "      classId: 'B2',\n      sessionId: session.id,\n      prNumber: live!.number,\n      currentHeadSha: live!.headRefOid,\n      source: 'issue_correlation',",
    replacement: "      classId: 'B2',\n      sessionId: session.id,\n      prNumber: live!.number,\n      currentHeadSha: '0'.repeat(40),\n      source: 'issue_correlation',",
  },
  'AC2:cross-repo-candidate-accepted': {
    anchor: 'value.repoSlug !== configuredRepo',
    replacement: 'false',
  },
  'AC3:untyped-live-key': {
    anchor: 'export function parseFoundationConfig(input: unknown = {}): FoundationConfigResult {\n',
    replacement: "export function parseFoundationConfig(input: unknown = {}): FoundationConfigResult {\n  void process.env.OPK_PR2_FOUNDATION_CONFIG;\n",
  },
  'AC3:malformed-value-defaulted': {
    anchor: "if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {",
    replacement: 'if (false) {',
  },
  'AC3:invalid-config-accepted': {
    anchor: "if (!isRecord(input)) return { ok: false, reason: 'invalid_config', path: '$' };",
    replacement: 'if (!isRecord(input)) return { ok: true, config: DEFAULT_FOUNDATION_CONFIG };',
  },
  'AC3:unknown-config-key-ignored': {
    anchor: 'const unknown = Object.keys(value).find((key) => !allowed.has(key));',
    replacement: 'const unknown = undefined;',
  },
  'AC3:notification-key-not-consumed-live': {
    anchor: 'config = notificationConfig(options.foundationConfig ?? {});',
    replacement: 'config = notificationConfig({});',
  },
  'AC3:foundation-config-activates-non-notification-consumer': {
    anchor: "return { ok: true, executed: false, reason: 'foundation_inert' };",
    replacement: "return { ok: true, executed: true, reason: 'foundation_inert' };",
  },
  'AC4:notify-before-journal': {
    anchor: "  try {\n    const inspected = await inspectNotification({\n      deliveryKey,\n      findingsHash,\n      maxAttempts: config.maxJournalAttempts,\n    });\n    if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };\n  } catch (error) {",
    replacement: "  try {\n    await runProcess({ command: config.aoPath, args: [], allowEmptyStdout: true, timeoutMs: 1 });\n    const inspected = await inspectNotification({\n      deliveryKey,\n      findingsHash,\n      maxAttempts: config.maxJournalAttempts,\n    });\n    if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };\n  } catch (error) {",
  },
  'AC4:historical-record-unreadable': {
    anchor: '  return canonicalFinalizeDispatchJournalRecord(\n    journal,\n    deliveryId,',
    replacement: '  return canonicalFinalizeDispatchJournalRecord(\n    {},\n    deliveryId,',
  },
  'AC5:journal-key-omitted': {
    anchor: "  if (!input.journalKey.trim()) return { ok: false, reason: 'journal_key_required' };",
    replacement: "  if (false) return { ok: false, reason: 'journal_key_required' };",
  },
  'AC5:prepared-after-mutation': {
    anchor: "      inject(input.crashAt, 'before_prepare');",
    replacement: "      writeFileSync(targetPath.path, sourceBytes, { mode: 0o600 });\n      inject(input.crashAt, 'before_prepare');",
  },
  'AC5:imported-before-durable-import': {
    anchor: "      inject(input.crashAt, 'before_import');",
    replacement: "      writeAtomic(journalPath.path, { ...record, state: 'imported', importedDigest: sourceDigest, importedAt: now });\n      inject(input.crashAt, 'before_import');",
  },
  'AC5:committed-before-imported': {
    anchor: "      inject(input.crashAt, 'before_import');",
    replacement: "      writeAtomic(journalPath.path, { ...record, state: 'committed', committedAt: now });\n      inject(input.crashAt, 'before_import');",
  },
  'AC5:marker-crash-reimports': {
    anchor: "    if (record.state === 'committed') {",
    replacement: '    if (false) {',
  },
  'AC5:torn-journal-accepted': {
    anchor: "  } catch {\n    return { ok: false, reason: 'corrupt_journal' };\n  }",
    replacement: "  } catch {\n    return { ok: true, record: null };\n  }",
  },
  'AC5:live-store-import-allowed': {
    anchor: '  for (const liveRoot of liveRootBoundaries(liveStoreRoots)) {',
    replacement: '  for (const liveRoot of ([] as string[])) {',
  },
  'AC6:catalog-surface-omitted': {
    anchor: "    if (!candidateById.has(required.id)) return { ok: false, reason: 'catalog_surface_omitted', surface: required.id };",
    replacement: "    if (false) return { ok: false, reason: 'catalog_surface_omitted', surface: required.id };",
  },
  'AC6:candidate-catalog-downgrade': {
    anchor: '    if (CLASS_RANK[next.classification] < CLASS_RANK[base.classification]) {',
    replacement: '    if (false) {',
  },
  'AC6:symlink-cleanup': {
    anchor: "  if (metadata.isSymbolicLink()) return { ok: false, reason: 'symlink_cleanup_refused' };",
    replacement: "  if (false) return { ok: false, reason: 'symlink_cleanup_refused' };",
  },
  'AC6:swap-after-check-delete': {
    anchor: '  if (input.beforeIdentity\n    && (current.dev !== input.beforeIdentity.dev || current.ino !== input.beforeIdentity.ino)) {',
    replacement: '  if (false) {',
  },
  'AC6:unsupported-platform-cleanup-enabled': {
    anchor: '  if (!platformSupportsDestructiveCleanup({ platform: input.platform, wslInterop: input.wslInterop })) {',
    replacement: '  if (false) {',
  },
  'AC8:suite-self-attests': {
    anchor: "resolve('scripts/pr2-foundation/mutation-semantic-check.ts')",
    replacement: "resolve('scripts/pr2-foundation/mutation-self-attesting-check.fixture.ts')",
  },
  'AC8:artifact-hash-delta-missing': {
    anchor: '  if (artifactHashAfter === artifactHashBefore) {',
    replacement: '  if (false) {',
  },
  'AC8:failing-test-identity-missing': {
    anchor: '  if (negative.ok || !negativeText.includes(failingTestId)) {',
    replacement: '  if (false) {',
  },
  'AC8:restore-hash-mismatch': {
    anchor: '  if (restoredHash !== artifactHashBefore) {',
    replacement: '  if (false) {',
  },
  'AC8:mutation-id-extra': {
    anchor: 'export const FOUNDATION_MUTATION_CATALOG: readonly MutationBinding[] = Object.freeze([',
    replacement: "export const FOUNDATION_MUTATION_CATALOG: readonly MutationBinding[] = Object.freeze([\n  { ac: 'AC1', mutationId: 'unexpected-extra', artifactPath: 'scripts/pr2-foundation/scheduler.ts', strategy: 'bounded-semantic', failingTestId: 'mutation-contract:AC1:unexpected-extra' },",
  },
  'AC8:mutation-id-missing': {
    anchor: "    'registry-changed': 'scripts/orchestrator-side-process-registry.json',\n",
    replacement: '',
  },
  'AC9:modification-outside-independent-union': {
    artifactPath: 'scripts/pr2-foundation/real-scope-proof.ts',
    anchor: '  const changedPaths = rows.map((row) => row.path);',
    replacement: "  const changedPaths = [...rows.map((row) => row.path), 'README.md'];",
  },
  'AC9:declaration-snapshot-missing': {
    artifactPath: 'scripts/pr2-foundation/real-scope-proof.ts',
    anchor: '  const resolved = resolveLatestCommittedSnapshotAtCommit(repoRoot, declarationCommitSha);',
    replacement: '  const resolved = resolveLatestCommittedSnapshot(repoRoot, 923);',
  },
  'AC9:declaration-created-after-implementation': {
    artifactPath: 'scripts/pr2-foundation/real-scope-proof.ts',
    anchor: '  const declarationCommitSha = declarationCommits[0];',
    replacement: "  const declarationCommitSha = git(repoRoot, ['rev-parse', 'HEAD']);",
  },
  'AC9:manifest-self-authorizes': {
    anchor: '  const exactExisting = new Set<string>([...EXACT_EXISTING_SCOPE_PATHS, ...FOUNDATION_DOC_ROWS].map(normalize));',
    replacement: "  const exactExisting = new Set<string>([...EXACT_EXISTING_SCOPE_PATHS, ...FOUNDATION_DOC_ROWS, 'README.md'].map(normalize));",
  },
  'AC9:addition-root-not-predeclared': {
    anchor: '      if (!declarationAllows(changed, declaration)) {',
    replacement: '      if (false) {',
  },
  'AC9:candidate-tag-self-authorizes': {
    anchor: '  const normalized = normalize(path);\n  if (declaration.declared_paths.map(normalize).includes(normalized)) return true;',
    replacement: "  const normalized = normalize(path);\n  if (normalized.startsWith('candidate/')) return true;\n  if (declaration.declared_paths.map(normalize).includes(normalized)) return true;",
  },
  'AC9:addition-root-exists-at-base': {
    anchor: '    if (base.has(addedPath)) return { ok: false, reason: `addition_root_exists_at_base:${addedPath}` };',
    replacement: '    if (false) return { ok: false, reason: `addition_root_exists_at_base:${addedPath}` };',
  },
  'AC9:symlink-mode': {
    anchor: "    if (mode === '120000') return { ok: false, reason: `symlink_mode:${changed}` };",
    replacement: "    if (false) return { ok: false, reason: `symlink_mode:${changed}` };",
  },
  'AC9:gitlink-mode': {
    anchor: "    if (mode === '160000') return { ok: false, reason: `gitlink_mode:${changed}` };",
    replacement: "    if (false) return { ok: false, reason: `gitlink_mode:${changed}` };",
  },
  'AC9:multi-revert-plan': {
    anchor: "  if (input.revertCommitCount !== 1) return { ok: false, reason: 'multi_revert_plan' };",
    replacement: "  if (false) return { ok: false, reason: 'multi_revert_plan' };",
  },
  'AC9:new-powershell-logic-added': {
    anchor: "    if (changed.endsWith('.ps1') && added.has(changed)) {",
    replacement: '    if (false) {',
  },
  'AC9:package-json-overreach': {
    anchor: 'npm run check:node-major --silent && node --experimental-strip-types scripts/pr2-foundation/contract-test-runner.ts',
    replacement: 'npm run check:node-major --silent && node --experimental-strip-types scripts/pr2-foundation/contract-test-runner.ts && echo overreach',
  },
});

const ESTATE_MUTATION_KEYS = new Set([
  'AC7:denominator-read-from-head',
  'AC7:foundation-row-omitted',
  'AC7:cutover-row-deleted',
  'AC7:cutover-owner-generic',
  'AC7:split-not-sixteen-six',
  'AC7:unrelated-manifest-row-changed',
]);

function applyEstateMutation(key: string, source: string | null): BoundedSemanticMutation {
  if (source === null) throw new Error(`mutation_target_missing:${key}`);
  const document = JSON.parse(source) as { rows?: Array<Record<string, unknown>> };
  const rows = document.rows ?? [];
  const foundationPath = 'docs/ao-0-10-review-api.mjs';
  const cutoverPath = 'scripts/lib/Get-ReactionMessagesFromYaml.ps1';
  if (key === 'AC7:denominator-read-from-head') {
    const row = rows.find((candidate) => candidate.path === foundationPath);
    if (row) rows.push({ ...row });
  } else if (key === 'AC7:foundation-row-omitted') {
    document.rows = rows.filter((candidate) => candidate.path !== foundationPath);
  } else if (key === 'AC7:cutover-row-deleted') {
    document.rows = rows.filter((candidate) => candidate.path !== cutoverPath);
  } else if (key === 'AC7:cutover-owner-generic') {
    const row = rows.find((candidate) => candidate.path === cutoverPath);
    if (row) row.replacementOwner = 'generic-owner';
  } else if (key === 'AC7:split-not-sixteen-six') {
    const row = rows.find((candidate) => candidate.path === foundationPath);
    if (row) row.terminalState = 'owned-by-PR-2-cutover';
  } else {
    const relevant = new Set([foundationPath, cutoverPath]);
    const row = rows.find((candidate) => typeof candidate.path === 'string' && !relevant.has(String(candidate.path)));
    if (row) row.reason = `${String(row.reason ?? '')}:mutation-overreach`;
  }
  const fallback = buildBoundedSemanticMutation(key, source);
  return {
    artifactPath: fallback.artifactPath,
    kind: 'replace',
    content: `${JSON.stringify(document, null, 2)}\n`,
    affectedOccurrences: 1,
    anchor: key,
  };
}

const LANE_MUTATION_KEYS = new Set([
  'AC9:test-classification-missing',
  'AC9:lane-config-overreach',
]);

function applyLaneMutation(key: string, source: string | null): BoundedSemanticMutation {
  if (source === null) throw new Error(`mutation_target_missing:${key}`);
  const document = JSON.parse(source) as { classification?: Record<string, string> };
  const classification = document.classification ?? {};
  if (key === 'AC9:test-classification-missing') {
    delete classification['scripts/pr2-foundation/mutation-semantic-gates.test.ts'];
  } else {
    classification['scripts/pr2-foundation/unexpected.test.ts'] = 'light';
  }
  const fallback = buildBoundedSemanticMutation(key, source);
  return {
    artifactPath: fallback.artifactPath,
    kind: 'replace',
    content: `${JSON.stringify(document, null, 2)}\n`,
    affectedOccurrences: 1,
    anchor: key,
  };
}

function applyTextRecipe(
  key: string,
  source: string | null,
  recipe: TextRecipe,
): BoundedSemanticMutation {
  if (source === null) throw new Error(`mutation_target_missing:${key}`);
  const affectedOccurrences = source.split(recipe.anchor).length - 1;
  if (affectedOccurrences !== 1) {
    throw new Error(`behavior_mutation_anchor_cardinality:${key}:${affectedOccurrences}`);
  }
  const artifactPath = recipe.artifactPath ?? buildBoundedSemanticMutation(key, source).artifactPath;
  return {
    artifactPath,
    kind: 'replace',
    content: source.replace(recipe.anchor, recipe.replacement),
    affectedOccurrences,
    anchor: recipe.anchor,
  };
}

export function buildBehavioralMutation(
  key: string,
  source: string | null,
): BoundedSemanticMutation {
  if (ESTATE_MUTATION_KEYS.has(key)) return applyEstateMutation(key, source);
  if (LANE_MUTATION_KEYS.has(key)) return applyLaneMutation(key, source);
  const recipe = EXECUTABLE_RECIPES[key];
  return recipe
    ? applyTextRecipe(key, source, recipe)
    : buildBoundedSemanticMutation(key, source);
}

export const EXECUTABLE_BEHAVIOR_MUTATION_KEYS = Object.freeze([
  ...Object.keys(EXECUTABLE_RECIPES),
  ...ESTATE_MUTATION_KEYS,
  ...LANE_MUTATION_KEYS,
].sort());
