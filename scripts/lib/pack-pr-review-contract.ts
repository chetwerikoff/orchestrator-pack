import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScopeSection, type ResolvedScopeContext } from '../../plugins/codex-pr-reviewer/lib/scope_context.ts';
import {
  PACK_GPT_SOURCE_COMMENT_NOTICE,
  formatPackGptSourceMarker,
  normalizePackGptSourceIdentity,
  type PackGptSourceIdentity,
} from './pack-gpt-source-comment-contract.ts';

export const CANONICAL_CONTRACT_RELATIVE = 'prompts/pack_pr_review_contract.md';
export const GPT_PROMPT_RELATIVE = 'prompts/gpt_pack_review_prompt.md';
export const CODEX_PROMPT_RELATIVE = 'prompts/codex_review_prompt.md';

export const CANONICAL_CONTRACT_CLAUSE_MARKERS = [
  'Optimize the merge decision, not finding count',
  'Three prose questions per reported finding',
  'Blocking is an economic decision',
  'Persistent machinery is priced only when proposed',
  'Operational envelope is explicit',
  'Security and scope carve-out',
  'Reviewer recommendations are prose only',
] as const;

export function resolvePackRepoRoot(fromModuleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(fromModuleUrl)), '..', '..');
}

export function loadCanonicalReviewContract(packRoot = resolvePackRepoRoot()): string {
  return readFileSync(join(packRoot, CANONICAL_CONTRACT_RELATIVE), 'utf8');
}

export function loadGptPromptTemplate(packRoot = resolvePackRepoRoot()): string {
  return readFileSync(join(packRoot, GPT_PROMPT_RELATIVE), 'utf8');
}

function sourcePublicationSection(identity: PackGptSourceIdentity | undefined): string {
  if (!identity) {
    return [
      'This is a standalone adapter invocation with no runner-bound source identity.',
      'Create **no** GitHub comment or other repository mutation; return the review payload only.',
    ].join('\n');
  }
  const normalized = normalizePackGptSourceIdentity(identity);
  const marker = formatPackGptSourceMarker(normalized);
  return [
    'After you have determined the source result and only after the final live-head recheck, create exactly one top-level PR Conversation comment.',
    'Never create a GitHub Review. Never edit or update the source comment after creation.',
    '',
    'The comment body must be exactly:',
    '',
    '```text',
    marker,
    PACK_GPT_SOURCE_COMMENT_NOTICE,
    '',
    '<PAYLOAD>',
    '```',
    '',
    '`<PAYLOAD>` is exactly the response-format payload below: either `NO_FINDINGS` or the single structured findings JSON object.',
    `Frozen repository: \`${normalized.repository}\``,
    `Frozen PR: \`#${normalized.prNumber}\``,
    `Frozen run: \`${normalized.runId}\``,
    `Frozen slot: \`${normalized.slotId}\``,
    `Frozen invocation: \`${normalized.invocationId}\``,
    `Frozen head: \`${normalized.headSha}\``,
    '',
    'Create zero canonical source artifacts if any frozen identity is not the target you can verify through the connected GitHub surface.',
  ].join('\n');
}

export function buildGptReviewPrompt(options: {
  prUrl: string;
  headSha: string;
  scope: ResolvedScopeContext;
  sourceIdentity?: PackGptSourceIdentity;
  packRoot?: string;
}): string {
  const packRoot = options.packRoot ?? resolvePackRepoRoot();
  const template = loadGptPromptTemplate(packRoot);
  const contract = loadCanonicalReviewContract(packRoot);
  const scopeSection = options.scope.hasScope
    ? formatScopeSection(options.scope)
    : '_Scope section omitted — no issue denylist fence and no declaration snapshot were available._';
  return template
    .replace('{{PR_URL}}', options.prUrl)
    .replaceAll('{{HEAD_SHA}}', options.headSha)
    .replace('{{SCOPE_SECTION}}', scopeSection)
    .replace('{{SOURCE_PUBLICATION_SECTION}}', sourcePublicationSection(options.sourceIdentity))
    .replace('{{CANONICAL_CONTRACT}}', contract);
}

export function codexPromptIncludesCanonicalContract(promptText: string): boolean {
  return CANONICAL_CONTRACT_CLAUSE_MARKERS.every((marker) => promptText.includes(marker));
}

export function gptPromptIncludesCanonicalContract(promptText: string): boolean {
  return CANONICAL_CONTRACT_CLAUSE_MARKERS.every((marker) => promptText.includes(marker));
}
