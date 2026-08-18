import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.ts';

const CANON_DECLARATION_PATH = '.claude/skills/create-issue-draft/SKILL.md';
const CANON_FENCE = 'manager-review-brief-canon';
const PLACEHOLDERS = {
  '<REPOSITORY>': (context: ManagerReviewBriefContext) => context.repositoryFullName,
  '<ISSUE_URL>': (context: ManagerReviewBriefContext) => `https://github.com/${context.repositoryFullName}/issues/${context.issueNumber}`,
  '<ISSUE_NUMBER>': (context: ManagerReviewBriefContext) => String(context.issueNumber),
  '<STAGE>': (context: ManagerReviewBriefContext) => context.stage,
  '<SLOT>': (context: ManagerReviewBriefContext) => context.sourceSlot,
  '<EXPECTED_REVISION>': (context: ManagerReviewBriefContext) => context.sourceRevision,
  '<INVOCATION_ID>': (context: ManagerReviewBriefContext) => context.invocationId,
} as const;

export interface ManagerReviewBriefContext {
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly sourceRevision: string;
  readonly stage: string;
  readonly sourceSlot: string;
  readonly invocationId: string;
}

export interface ManagerReviewCanonDiagnostic {
  readonly path: string;
  readonly blobSha: string;
}

export interface ManagerReviewCanonSection {
  readonly path: string;
  readonly heading: string;
  readonly text: string;
}

export interface ManagerReviewCanonSnapshot {
  readonly sections: readonly ManagerReviewCanonSection[];
  readonly diagnostics: readonly ManagerReviewCanonDiagnostic[];
}

export interface RenderedManagerReviewBrief {
  readonly text: string;
  readonly sha256: string;
  readonly diagnostics: readonly ManagerReviewCanonDiagnostic[];
}

export interface ManagerReviewPromptMismatch {
  readonly expectedSha256: string;
  readonly observedSha256: string;
  readonly diagnostics: readonly ManagerReviewCanonDiagnostic[];
  readonly cause: string;
}

export interface ManagerReviewBriefReadOptions {
  readonly repositoryRoot?: string;
  readonly ref?: string;
}

interface TrackedSource {
  readonly path: string;
  readonly text: string;
  readonly blobSha: string;
}

function defaultRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateContext(context: ManagerReviewBriefContext): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repositoryFullName)) {
    throw new Error('canonical_prompt_context_invalid:repository');
  }
  if (!Number.isSafeInteger(context.issueNumber) || context.issueNumber < 1) {
    throw new Error('canonical_prompt_context_invalid:issue_number');
  }
  if (!/^r[0-9]{2,}$/.test(context.sourceRevision)) {
    throw new Error('canonical_prompt_context_invalid:source_revision');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(context.stage)) {
    throw new Error('canonical_prompt_context_invalid:stage');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(context.sourceSlot)) {
    throw new Error('canonical_prompt_context_invalid:source_slot');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(context.invocationId)) {
    throw new Error('canonical_prompt_context_invalid:invocation_id');
  }
}

function runGit(
  repositoryRoot: string,
  args: readonly string[],
  allowEmptyStdout = false,
): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repositoryRoot,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  if (!result.ok && !(allowEmptyStdout && result.outcome === 'exit' && result.exitCode === 0)) {
    throw new Error('canonical_prompt_source_unavailable');
  }
  return result.stdout;
}

function readTrackedSource(
  path: string,
  options: ManagerReviewBriefReadOptions,
): TrackedSource {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot();
  const ref = options.ref ?? 'HEAD';
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.includes('..')) {
    throw new Error('canonical_prompt_declaration_invalid:path');
  }
  const text = runGit(repositoryRoot, ['show', `${ref}:${path}`], true);
  const blobSha = runGit(repositoryRoot, ['rev-parse', `${ref}:${path}`]).trim();
  if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error('canonical_prompt_source_unavailable');
  return { path, text, blobSha };
}

function extractCanonDeclaration(text: string): readonly { path: string; heading: string }[] {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === `\`\`\`${CANON_FENCE}`);
  if (open < 0) throw new Error('canonical_prompt_declaration_missing');
  const closeOffset = lines.slice(open + 1).findIndex((line) => line.trim() === '```');
  if (closeOffset < 0) throw new Error('canonical_prompt_declaration_invalid:unterminated');
  const rows = lines.slice(open + 1, open + 1 + closeOffset).filter((line) => line.trim().length > 0);
  if (rows.length === 0) throw new Error('canonical_prompt_declaration_invalid:empty');
  const parsed = rows.map((row) => {
    const separator = row.indexOf(' :: ');
    if (separator <= 0) throw new Error('canonical_prompt_declaration_invalid:row');
    const path = row.slice(0, separator).trim();
    const heading = row.slice(separator + 4).trim();
    if (!path || !/^#{2,6}\s+\S/.test(heading)) {
      throw new Error('canonical_prompt_declaration_invalid:row');
    }
    return { path, heading };
  });
  const identities = new Set<string>();
  for (const row of parsed) {
    const identity = `${row.path}\u0000${row.heading}`;
    if (identities.has(identity)) throw new Error('canonical_prompt_declaration_invalid:duplicate');
    identities.add(identity);
  }
  return parsed;
}

function extractMarkdownSection(text: string, expectedHeading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === expectedHeading);
  if (start < 0) throw new Error(`canonical_prompt_section_missing:${expectedHeading}`);
  if (lines.findIndex((line, index) => index > start && line === expectedHeading) >= 0) {
    throw new Error(`canonical_prompt_section_ambiguous:${expectedHeading}`);
  }
  const level = expectedHeading.match(/^#+/)?.[0].length ?? 0;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const match = lines[index]?.match(/^(#{1,6})\s+\S/);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\n+$/u, '');
}

export function readManagerReviewCanon(
  options: ManagerReviewBriefReadOptions = {},
): ManagerReviewCanonSnapshot {
  const declarationSource = readTrackedSource(CANON_DECLARATION_PATH, options);
  const declaration = extractCanonDeclaration(declarationSource.text);
  const sources = new Map<string, TrackedSource>([[declarationSource.path, declarationSource]]);
  for (const row of declaration) {
    if (!sources.has(row.path)) sources.set(row.path, readTrackedSource(row.path, options));
  }
  const sections = declaration.map((row) => ({
    path: row.path,
    heading: row.heading,
    text: extractMarkdownSection(sources.get(row.path)!.text, row.heading),
  }));
  const diagnostics = [...sources.values()].map(({ path, blobSha }) => ({ path, blobSha }));
  return { sections, diagnostics };
}

function substituteBoundContext(text: string, context: ManagerReviewBriefContext): string {
  let rendered = text;
  for (const [placeholder, resolver] of Object.entries(PLACEHOLDERS) as Array<[
    keyof typeof PLACEHOLDERS,
    (context: ManagerReviewBriefContext) => string,
  ]>) {
    rendered = rendered.split(placeholder).join(resolver(context));
  }
  return rendered;
}

export function renderManagerReviewBrief(
  snapshot: ManagerReviewCanonSnapshot,
  context: ManagerReviewBriefContext,
): RenderedManagerReviewBrief {
  validateContext(context);
  const text = `${snapshot.sections
    .map((section) => substituteBoundContext(section.text, context))
    .join('\n\n')}\n`;
  for (const placeholder of Object.keys(PLACEHOLDERS)) {
    if (text.includes(placeholder)) throw new Error(`canonical_prompt_context_unresolved:${placeholder}`);
  }
  return { text, sha256: sha256(text), diagnostics: snapshot.diagnostics };
}

export function renderManagerReviewBriefBatch(
  snapshot: ManagerReviewCanonSnapshot,
  contexts: readonly ManagerReviewBriefContext[],
): readonly RenderedManagerReviewBrief[] {
  if (contexts.length === 0) throw new Error('canonical_prompt_context_invalid:empty_batch');
  return contexts.map((context) => renderManagerReviewBrief(snapshot, context));
}

export function prepareManagerReviewBriefBatch(
  contexts: readonly ManagerReviewBriefContext[],
  options: ManagerReviewBriefReadOptions = {},
): readonly RenderedManagerReviewBrief[] {
  const snapshot = readManagerReviewCanon(options);
  return renderManagerReviewBriefBatch(snapshot, contexts);
}

function mismatchCause(
  expectedSha256: string,
  observedSha256: string,
  diagnostics: readonly ManagerReviewCanonDiagnostic[],
): string {
  const sources = diagnostics.map(({ path, blobSha }) => `${path}@${blobSha}`).join(',');
  return `canonical_prompt_mismatch:expected_sha256=${expectedSha256};observed_sha256=${observedSha256};sources=${sources}`;
}

export function compareManagerReviewBrief(
  observedText: string,
  context: ManagerReviewBriefContext,
  options: ManagerReviewBriefReadOptions = {},
): { readonly ok: true; readonly expected: RenderedManagerReviewBrief }
  | { readonly ok: false; readonly mismatch: ManagerReviewPromptMismatch } {
  const expected = renderManagerReviewBrief(readManagerReviewCanon(options), context);
  if (observedText === expected.text) return { ok: true, expected };
  const observedSha256 = sha256(observedText);
  return {
    ok: false,
    mismatch: {
      expectedSha256: expected.sha256,
      observedSha256,
      diagnostics: expected.diagnostics,
      cause: mismatchCause(expected.sha256, observedSha256, expected.diagnostics),
    },
  };
}

export function assertCanonicalManagerReviewBrief(
  observedText: string,
  context: ManagerReviewBriefContext,
  options: ManagerReviewBriefReadOptions = {},
): RenderedManagerReviewBrief {
  const comparison = compareManagerReviewBrief(observedText, context, options);
  if (!comparison.ok) throw new Error(comparison.mismatch.cause);
  return comparison.expected;
}
