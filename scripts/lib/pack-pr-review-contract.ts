import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScopeSection, type ResolvedScopeContext } from '../../plugins/ao-codex-pr-reviewer/lib/scope_context.ts';

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

export function buildGptReviewPrompt(options: {
  prUrl: string;
  headSha: string;
  scope: ResolvedScopeContext;
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
    .replace('{{HEAD_SHA}}', options.headSha)
    .replace('{{SCOPE_SECTION}}', scopeSection)
    .replace('{{CANONICAL_CONTRACT}}', contract);
}

export function codexPromptIncludesCanonicalContract(promptText: string): boolean {
  return CANONICAL_CONTRACT_CLAUSE_MARKERS.every((marker) => promptText.includes(marker));
}

export function gptPromptIncludesCanonicalContract(promptText: string): boolean {
  return CANONICAL_CONTRACT_CLAUSE_MARKERS.every((marker) => promptText.includes(marker));
}
