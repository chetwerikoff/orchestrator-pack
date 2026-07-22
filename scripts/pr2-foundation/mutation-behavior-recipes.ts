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
  'AC2:schema-shape-changed': {
    anchor: "  'updatedAt',\n] as const",
    replacement: "  'updatedAt',\n  'branch',\n] as const",
  },
  'AC2:hypothetical-prs-or-branch-trust': {
    anchor: 'return forms.some((pattern) => pattern.test(normalized));',
    replacement: 'return true;',
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
  'AC3:untyped-live-key': {
    anchor: 'export function parseFoundationConfig(input: unknown = {}): FoundationConfigResult {\n',
    replacement: "export function parseFoundationConfig(input: unknown = {}): FoundationConfigResult {\n  void process.env.OPK_PR2_FOUNDATION_CONFIG;\n",
  },
  'AC3:invalid-config-accepted': {
    anchor: 'if (!isRecord(input))',
    replacement: 'if (false)',
  },
  'AC3:notification-key-not-consumed-live': {
    anchor: 'config = notificationConfig(options.foundationConfig ?? {});',
    replacement: 'config = notificationConfig({});',
  },
  'AC3:foundation-config-activates-non-notification-consumer': {
    anchor: "return { ok: true, executed: false, reason: 'foundation_inert' };",
    replacement: "return { ok: true, executed: true, reason: 'foundation_inert' };",
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
