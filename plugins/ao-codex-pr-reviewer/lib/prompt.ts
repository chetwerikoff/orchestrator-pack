import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScopeSection, type ResolvedScopeContext } from './scope_context.js';
import type { ReviewSource } from './types.js';

const PROMPT_RELATIVE = join('prompts', 'codex_review_prompt.md');

function repoPromptPath(repoRoot: string): string {
  return join(repoRoot, PROMPT_RELATIVE);
}

function bundledPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'prompts', 'codex_review_prompt.md');
}

export function loadPromptTemplate(repoRoot: string): string {
  try {
    return readFileSync(repoPromptPath(repoRoot), 'utf8');
  } catch {
    return readFileSync(bundledPromptPath(), 'utf8');
  }
}

export function buildReviewPrompt(options: {
  repoRoot: string;
  scope: ResolvedScopeContext;
  source: ReviewSource;
}): string {
  const template = loadPromptTemplate(options.repoRoot);
  const scopeSection = options.scope.hasScope
    ? formatScopeSection(options.scope)
    : '_Scope section omitted — no issue denylist fence and no declaration snapshot were available._';
  return template
    .replace('{{SCOPE_SECTION}}', scopeSection)
    .replace(/\{\{SOURCE\}\}/g, options.source);
}
