import { readStableInput } from './input.ts';
import { turnExitCode } from './contracts.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  assertCanonicalManagerReviewBrief,
  type ManagerReviewBriefContext,
} from '../lib/manager-review-brief.ts';
import {
  runStateLightTurn as runStateLightTurnCore,
  type StateLightTurnDependencies,
} from './state-light-turn-core.ts';

export * from './state-light-turn-core.ts';

const DIRECT_KEYS = [
  'reviewer-source-output',
  'reviewer-source',
  'repository',
  'issue-number',
  'source-revision',
] as const;
const CANON_CONTEXT_KEYS = ['stage', 'source-slot'] as const;

function optionValue(argv: readonly string[], key: string): string | undefined {
  const flag = `--${key}`;
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

function hasOption(argv: readonly string[], key: string): boolean {
  return argv.includes(`--${key}`);
}

function directPublicationRequested(argv: readonly string[]): boolean {
  return DIRECT_KEYS.some((key) => hasOption(argv, key));
}

function requiredCanonicalOption(argv: readonly string[], key: string): string {
  const value = optionValue(argv, key);
  if (!value) throw new Error(`canonical_prompt_context_missing:${key.replaceAll('-', '_')}`);
  return value;
}

function canonicalContext(argv: readonly string[]): ManagerReviewBriefContext {
  const issueNumberRaw = requiredCanonicalOption(argv, 'issue-number');
  if (!/^[1-9][0-9]*$/.test(issueNumberRaw)) {
    throw new Error('canonical_prompt_context_invalid:issue_number');
  }
  return {
    repositoryFullName: requiredCanonicalOption(argv, 'repository'),
    issueNumber: Number(issueNumberRaw),
    sourceRevision: requiredCanonicalOption(argv, 'source-revision'),
    stage: requiredCanonicalOption(argv, 'stage'),
    sourceSlot: requiredCanonicalOption(argv, 'source-slot'),
    invocationId: requiredCanonicalOption(argv, 'invocation-id'),
  };
}

function stripCanonicalContext(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (CANON_CONTEXT_KEYS.some((key) => token === `--${key}`)) {
      index++;
      continue;
    }
    stripped.push(token!);
  }
  return stripped;
}

function rejectionProfileKey(argv: readonly string[]): string {
  const profile = optionValue(argv, 'profile');
  const cdp = optionValue(argv, 'cdp');
  if (!profile || !cdp) return 'profile-unresolved';
  try {
    return configuredProfileKey(profile, cdp);
  } catch {
    return 'profile-unresolved';
  }
}

function canonicalCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('canonical_prompt_')) return message;
  if (message.startsWith('input_invalid:')) {
    return `canonical_prompt_input_${message.slice('input_invalid:'.length)}`;
  }
  return 'canonical_prompt_source_unavailable';
}

function emitCanonicalRefusal(argv: readonly string[], cause: string): number {
  const invocationId = optionValue(argv, 'invocation-id') ?? '';
  process.stdout.write(`${JSON.stringify({
    schema: 'turn-result/v1',
    state: 'input_invalid',
    scope: 'invocation',
    cause,
    invocation_id: invocationId,
    configured_profile_key: rejectionProfileKey(argv),
    send_count: 0,
    poll_count: 0,
    goto_count: 0,
    new_chat_click_count: 0,
    navigation_count: 0,
    cleanup: 'skipped',
    incidents: [],
  })}\n`);
  return turnExitCode('input_invalid');
}

/**
 * Canonical state-light entry for Browser-GPT turns.
 *
 * Governed direct-publication inputs are independently regenerated from the
 * current tracked create-Issue canon before the core is allowed to execute any
 * browser effect. `stage` and `source-slot` are gate-only context and are
 * intentionally stripped before delegating to the pre-existing transport core.
 */
export async function runStateLightTurn(
  argv: readonly string[],
  dependencies: StateLightTurnDependencies = {},
): Promise<number> {
  if (!directPublicationRequested(argv)) {
    return await runStateLightTurnCore(argv, dependencies);
  }

  try {
    requiredCanonicalOption(argv, 'reviewer-source-output');
    requiredCanonicalOption(argv, 'reviewer-source');
    const inputPath = requiredCanonicalOption(argv, 'input');
    const context = canonicalContext(argv);
    const snapshot = readStableInput(inputPath);
    assertCanonicalManagerReviewBrief(snapshot.text, context);
  } catch (error) {
    return emitCanonicalRefusal(argv, canonicalCause(error));
  }

  return await runStateLightTurnCore(stripCanonicalContext(argv), dependencies);
}
