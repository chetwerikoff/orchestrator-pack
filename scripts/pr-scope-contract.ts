/**
 * Canonical PR scope-guard contracts for issue links and no-ceremony docs PRs.
 * TypeScript is the single source of truth; retired shell wrappers do not own parsing.
 * See docs/repository_policy.md § Spec-only docs PRs.
 */

import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { pathMatchesAnyPattern } from '../plugins/scope-guard/lib/glob_match.ts';

/** Alternation fragment shared with drift tests (must stay stable). */
export const CLOSING_KEYWORD_ALTERNATION =
  'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved';

/** GitHub-supported closing keywords. */
export const ISSUE_LINK_PATTERN = new RegExp(
  `\\b(?:${CLOSING_KEYWORD_ALTERNATION})\\s+#(\\d+)\\b`,
  'gi',
);

/** Non-closing issue references are detected so no-ceremony PRs can reject all Issue links. */
export const NON_CLOSING_ISSUE_REF_PATTERN = new RegExp(
  '\\b(?:ref|refs|see|related\\s+to)\\s+#(\\d+)\\b',
  'gi',
);

/** GitHub issue page URL (not pull request URLs). */
export const GITHUB_ISSUE_URL_PATTERN =
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/gi;

/** Bare `#123` issue autolink (after start-of-string or non-word/non-#). */
export const BARE_ISSUE_HASH_PATTERN = /(?:^|[^\w#/])#(\d+)\b/g;

/** Canonical skill instruction surface (markdown only; see NO_CEREMONY_SKILL_MARKDOWN_GLOBS). */
export const NO_CEREMONY_SKILL_CANONICAL_ROOT = '.cursor/skills';

/** Generated pointer skill surfaces (markdown only; see NO_CEREMONY_SKILL_MARKDOWN_GLOBS). */
export const NO_CEREMONY_SKILL_POINTER_ROOTS: readonly string[] = ['.claude/skills'] as const;

/**
 * Markdown-only skill paths admitted on no-ceremony PRs (conjunctive with docs entries).
 * Non-markdown files under skill directories stay on the implementation path.
 */
export const NO_CEREMONY_SKILL_MARKDOWN_GLOBS: readonly string[] = [
  `${NO_CEREMONY_SKILL_CANONICAL_ROOT}/**/*.md`,
  ...NO_CEREMONY_SKILL_POINTER_ROOTS.map((root) => `${root}/**/*.md`),
] as const;

/**
 * Markdown-only documentation paths admitted on no-ceremony PRs.
 */
export const NO_CEREMONY_DOC_MARKDOWN_GLOBS: readonly string[] = [
  'docs/architecture.md',
] as const;

/**
 * Union surface for diff-content no-ceremony PRs (skill instruction + spec-docs markdown).
 */
export const NO_CEREMONY_MARKDOWN_GLOBS: readonly string[] = [
  ...NO_CEREMONY_DOC_MARKDOWN_GLOBS,
  ...NO_CEREMONY_SKILL_MARKDOWN_GLOBS,
] as const;


export function normalizePrBody(prBody: string): string {
  return prBody.replace(/^\uFEFF/, '').trim();
}

/** Remove fenced code blocks so documented signal examples do not trigger detection. */
export function stripMarkdownFencedCodeBlocks(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
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

/** Issue numbers linked anywhere in a no-ceremony PR body (all supported GitHub forms). */
export function findNoCeremonyIssueLinks(prBody: string): number[] {
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

export function hasNoCeremonyIssueLink(prBody: string): boolean {
  return findNoCeremonyIssueLinks(prBody).length > 0;
}

/** @deprecated Use findNoCeremonyIssueLinks */
export const findSkillDocIssueLinks = findNoCeremonyIssueLinks;

/** @deprecated Use hasNoCeremonyIssueLink */
export const hasSkillDocIssueLink = hasNoCeremonyIssueLink;

/**
 * True when every changed path is markdown within the no-ceremony union surface
 * (conjunctive; empty diff does not qualify).
 */
export function isNoCeremonyPr(prPaths: string[]): boolean {
  if (prPaths.length === 0) {
    return false;
  }
  return classifyNoCeremonyPaths(prPaths).ok;
}

/** @deprecated Use isNoCeremonyPr */
export const isSkillDocPr = isNoCeremonyPr;

export function classifyNoCeremonyPaths(prPaths: string[]): {
  ok: true;
  checkedPaths: string[];
} | {
  ok: false;
  outOfNoCeremonyMarkdown: string[];
  invalidPaths: Array<{ path: string; reason: string }>;
  checkedPaths: string[];
} {
  const outOfNoCeremonyMarkdown: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];

  for (const rawPath of prPaths) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    checkedPaths.push(normalized.path);

    if (!pathMatchesAnyPattern(normalized.path, [...NO_CEREMONY_MARKDOWN_GLOBS])) {
      outOfNoCeremonyMarkdown.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return { ok: false, outOfNoCeremonyMarkdown, invalidPaths, checkedPaths };
  }

  if (outOfNoCeremonyMarkdown.length > 0) {
    return { ok: false, outOfNoCeremonyMarkdown, invalidPaths: [], checkedPaths };
  }

  return { ok: true, checkedPaths };
}

/** @deprecated Use classifyNoCeremonyPaths */
export function classifySkillDocPaths(prPaths: string[]): {
  ok: true;
  checkedPaths: string[];
} | {
  ok: false;
  outOfSkillMarkdown: string[];
  invalidPaths: Array<{ path: string; reason: string }>;
  checkedPaths: string[];
} {
  const result = classifyNoCeremonyPaths(prPaths);
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    outOfSkillMarkdown: result.outOfNoCeremonyMarkdown,
    invalidPaths: result.invalidPaths,
    checkedPaths: result.checkedPaths,
  };
}


/** @deprecated Use extractClosingIssueNumber — kept for callers that mean closing refs only. */
export const extractLinkedIssueNumber = extractClosingIssueNumber;

/** Issue number to load for implementation scope validation (null when not yet resolved). */
export function resolveIssueNumberForFetch(prBody: string): number | null {
  return extractClosingIssueNumber(prBody);
}
