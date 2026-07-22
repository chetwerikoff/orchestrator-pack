import {
  buildBoundedSemanticMutation,
  type BoundedSemanticMutation,
} from './mutation-semantic-gates.ts';

interface TextRecipe {
  anchor: string;
  replacement: string;
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
  'AC4:historical-record-unreadable': {
    anchor: '  return canonicalFinalizeDispatchJournalRecord(\n    journal,\n    deliveryId,',
    replacement: '  return canonicalFinalizeDispatchJournalRecord(\n    {},\n    deliveryId,',
  },
});

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
  const fallback = buildBoundedSemanticMutation(key, source);
  return {
    artifactPath: fallback.artifactPath,
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
  const recipe = EXECUTABLE_RECIPES[key];
  return recipe
    ? applyTextRecipe(key, source, recipe)
    : buildBoundedSemanticMutation(key, source);
}

export const EXECUTABLE_BEHAVIOR_MUTATION_KEYS = Object.freeze(
  Object.keys(EXECUTABLE_RECIPES).sort(),
);
