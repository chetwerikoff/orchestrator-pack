/**
 * Canonical PR scope-guard contracts for issue links and spec-only docs PRs.
 * TypeScript is the single source of truth; PowerShell delegates parsing to TS.
 * See docs/repository_policy.md § Spec-only docs PRs.
 */

import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { pathMatchesAnyPattern } from '../plugins/ao-scope-guard/lib/glob_match.js';

/** Alternation fragment shared with drift tests (must stay stable). */
export const CLOSING_KEYWORD_ALTERNATION =
  'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved';

/** GitHub-supported closing keywords. */
export const ISSUE_LINK_PATTERN = new RegExp(
  `\\b(?:${CLOSING_KEYWORD_ALTERNATION})\\s+#(\\d+)\\b`,
  'gi',
);

/** Non-closing issue references accepted on spec-only PRs (no GitHub auto-close). */
export const NON_CLOSING_ISSUE_REF_PATTERN = new RegExp(
  '\\b(?:ref|refs|see|related\\s+to)\\s+#(\\d+)\\b',
  'gi',
);

/** GitHub issue page URL (not pull request URLs). */
export const GITHUB_ISSUE_URL_PATTERN =
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/gi;

/** Bare `#123` issue autolink (after start-of-string or non-word/non-#). */
export const BARE_ISSUE_HASH_PATTERN = /(?:^|[^\w#/])#(\d+)\b/g;

/**
 * Machine-detectable spec-only PR signal. Place on its own line near the top of the PR body.
 * Documented in docs/repository_policy.md.
 */
export const SPEC_ONLY_SIGNAL_LITERAL = '<!-- pr-type: spec-only -->';

/** Whole-line signal (policy: HTML comment on its own line). */
export const SPEC_ONLY_SIGNAL_LINE_PATTERN = /^<!--\s*pr-type:\s*spec-only\s*-->\s*$/i;

/**
 * Runtime spec-docs allowlist for spec-only PRs (narrow docs-only; not issue allowed-roots).
 * Enumerated in docs/repository_policy.md.
 */
/** Canonical skill instruction surface (markdown only; see SPEC_SKILL_MARKDOWN_GLOBS). */
export const SPEC_SKILL_CANONICAL_ROOT = '.claude/skills';

/** Generated pointer skill surfaces (markdown only; see SPEC_SKILL_MARKDOWN_GLOBS). */
export const SPEC_SKILL_POINTER_ROOTS: readonly string[] = ['.cursor/skills'] as const;

/**
 * Markdown-only skill paths admitted on spec-only PRs (conjunctive with docs entries).
 * Non-markdown files under skill directories stay on the implementation path.
 */
export const SPEC_SKILL_MARKDOWN_GLOBS: readonly string[] = [
  `${SPEC_SKILL_CANONICAL_ROOT}/**/*.md`,
  ...SPEC_SKILL_POINTER_ROOTS.map((root) => `${root}/**/*.md`),
] as const;

export const SPEC_DOCS_ALLOWLIST: readonly string[] = [
  'docs/issues_drafts/**',
  'docs/issue_queue_index.md',
  'docs/architecture.md',
  'docs/issues_drafts/00-architecture-decisions.md',
  ...SPEC_SKILL_MARKDOWN_GLOBS,
] as const;

export function normalizePrBody(prBody: string): string {
  return prBody.replace(/^\uFEFF/, '').trim();
}

/** Remove fenced code blocks so documented signal examples do not trigger detection. */
export function stripMarkdownFencedCodeBlocks(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
}

export function hasSpecOnlySignal(prBody: string): boolean {
  const scannable = stripMarkdownFencedCodeBlocks(normalizePrBody(prBody));
  for (const line of scannable.split(/\r?\n/)) {
    if (SPEC_ONLY_SIGNAL_LINE_PATTERN.test(line.trim())) {
      return true;
    }
  }
  return false;
}

export function hasClosingIssueReference(prBody: string): boolean {
  const normalized = normalizePrBody(prBody);
  ISSUE_LINK_PATTERN.lastIndex = 0;
  const found = ISSUE_LINK_PATTERN.test(normalized);
  ISSUE_LINK_PATTERN.lastIndex = 0;
  return found;
}

export function extractClosingIssueNumber(prBody: string): number | null {
  const normalized = normalizePrBody(prBody);
  ISSUE_LINK_PATTERN.lastIndex = 0;
  const matches = [...normalized.matchAll(ISSUE_LINK_PATTERN)];
  if (matches.length === 0) {
    return null;
  }

  const issueNumber = Number(matches[matches.length - 1]![1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return issueNumber;
}

export function extractNonClosingIssueNumber(prBody: string): number | null {
  const normalized = normalizePrBody(prBody);
  NON_CLOSING_ISSUE_REF_PATTERN.lastIndex = 0;
  const matches = [...normalized.matchAll(NON_CLOSING_ISSUE_REF_PATTERN)];
  if (matches.length === 0) {
    return null;
  }

  const issueNumber = Number(matches[matches.length - 1]![1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return issueNumber;
}

/** PR body text scanned for issue links (fenced code blocks omitted). */
export function prBodyScannableForIssueLinks(prBody: string): string {
  return stripMarkdownFencedCodeBlocks(normalizePrBody(prBody));
}

const SKILL_DOC_ISSUE_LINK_PATTERNS: readonly RegExp[] = [
  ISSUE_LINK_PATTERN,
  NON_CLOSING_ISSUE_REF_PATTERN,
  GITHUB_ISSUE_URL_PATTERN,
  BARE_ISSUE_HASH_PATTERN,
];

/** Issue numbers linked anywhere in a skill-doc PR body (all supported GitHub forms). */
export function findSkillDocIssueLinks(prBody: string): number[] {
  const text = prBodyScannableForIssueLinks(prBody);
  const linked = new Set<number>();

  for (const pattern of SKILL_DOC_ISSUE_LINK_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const issueNumber = Number(match[1]);
      if (Number.isInteger(issueNumber) && issueNumber > 0) {
        linked.add(issueNumber);
      }
    }
  }

  return [...linked];
}

export function hasSkillDocIssueLink(prBody: string): boolean {
  return findSkillDocIssueLinks(prBody).length > 0;
}

/**
 * True when every changed path is markdown under the skill instruction surfaces
 * (conjunctive; empty diff does not qualify).
 */
export function isSkillDocPr(prPaths: string[]): boolean {
  if (prPaths.length === 0) {
    return false;
  }
  return classifySkillDocPaths(prPaths).ok;
}

export function classifySkillDocPaths(prPaths: string[]): {
  ok: true;
  checkedPaths: string[];
} | {
  ok: false;
  outOfSkillMarkdown: string[];
  invalidPaths: Array<{ path: string; reason: string }>;
  checkedPaths: string[];
} {
  const outOfSkillMarkdown: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];

  for (const rawPath of prPaths) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    checkedPaths.push(normalized.path);

    if (!pathMatchesAnyPattern(normalized.path, [...SPEC_SKILL_MARKDOWN_GLOBS])) {
      outOfSkillMarkdown.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return { ok: false, outOfSkillMarkdown, invalidPaths, checkedPaths };
  }

  if (outOfSkillMarkdown.length > 0) {
    return { ok: false, outOfSkillMarkdown, invalidPaths: [], checkedPaths };
  }

  return { ok: true, checkedPaths };
}

export function classifySpecDocsPaths(prPaths: string[]): {
  ok: true;
  checkedPaths: string[];
} | {
  ok: false;
  outOfAllowlist: string[];
  invalidPaths: Array<{ path: string; reason: string }>;
  checkedPaths: string[];
} {
  const outOfAllowlist: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];

  for (const rawPath of prPaths) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    checkedPaths.push(normalized.path);

    if (!pathMatchesAnyPattern(normalized.path, [...SPEC_DOCS_ALLOWLIST])) {
      outOfAllowlist.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return { ok: false, outOfAllowlist, invalidPaths, checkedPaths };
  }

  if (outOfAllowlist.length > 0) {
    return { ok: false, outOfAllowlist, invalidPaths: [], checkedPaths };
  }

  return { ok: true, checkedPaths };
}

/** @deprecated Use extractClosingIssueNumber — kept for callers that mean closing refs only. */
export const extractLinkedIssueNumber = extractClosingIssueNumber;

/** Issue number to load for implementation scope validation (null when not yet resolved). */
export function resolveIssueNumberForFetch(prBody: string): number | null {
  if (hasSpecOnlySignal(prBody)) {
    return extractNonClosingIssueNumber(prBody);
  }
  return extractClosingIssueNumber(prBody);
}
