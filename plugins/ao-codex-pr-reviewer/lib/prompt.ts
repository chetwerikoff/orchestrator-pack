import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatScopeSection, type ResolvedScopeContext } from './scope_context.js';
import type { ReviewSource } from './types.js';

function bundledPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'prompts', 'codex_review_prompt.md');
}

/**
 * Load the pack-owned review prompt. Never reads prompts/codex_review_prompt.md
 * from the reviewed workspace (untrusted in CI / target-repo runs).
 * Optional AO_CODEX_REVIEW_PROMPT_FILE overrides for local trusted development only.
 */
export function loadPromptTemplate(): string {
  const trustedOverride = process.env.AO_CODEX_REVIEW_PROMPT_FILE?.trim();
  if (trustedOverride) {
    return readFileSync(trustedOverride, 'utf8');
  }
  return readFileSync(bundledPromptPath(), 'utf8');
}

export function buildReviewPrompt(options: {
  scope: ResolvedScopeContext;
  source: ReviewSource;
}): string {
  const template = loadPromptTemplate();
  const scopeSection = options.scope.hasScope
    ? formatScopeSection(options.scope)
    : '_Scope section omitted — no issue denylist fence and no declaration snapshot were available._';
  return template
    .replace('{{SCOPE_SECTION}}', scopeSection)
    .replace(/\{\{SOURCE\}\}/g, options.source);
}
