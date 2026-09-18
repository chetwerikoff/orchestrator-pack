#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { runProcessSync } from '#opk-kernel/subprocess';

export const OPS_WIKI_MANIFEST_RELATIVE = 'scripts/data/ops-wiki-manifest.json';
export const OPS_WIKI_GOLDEN_RELATIVE = 'scripts/fixtures/ops-wiki-golden-queries.json';
export const OPS_WIKI_STATUS_NOTE = 'Ops Wiki Status.md';
export const OPS_WIKI_EPISODE_DIR = 'episodes';
export const DEFAULT_CONVERGENCE_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 200;
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 5_000;

export type GitRunner = (cwd: string, args: readonly string[]) => { ok: boolean; stdout: string; stderr: string };
export type OpsWikiMode = 'plan' | 'apply' | 'check';
export type ReindexMode = 'incremental' | 'full';

export interface WikiOpsSearchHit {
  readonly path: string;
  readonly title?: string;
  readonly score?: number;
  readonly snippet?: string;
}

export interface WikiOpsReadOk {
  readonly ok: true;
  readonly path: string;
  readonly content: string;
}

export interface WikiOpsReadFail {
  readonly ok: false;
  readonly reason: 'absent' | 'timeout' | 'unavailable' | 'malformed';
}

export type WikiOpsReadResult = WikiOpsReadOk | WikiOpsReadFail;

export interface WikiOpsSearchInput {
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly mode?: 'hybrid' | 'fulltext' | 'title';
  readonly limit?: number;
}

export interface WikiOpsClient {
  readonly read: (path: string, options?: { readonly related?: boolean }) => Promise<WikiOpsReadResult>;
  readonly search: (input: WikiOpsSearchInput) => Promise<WikiOpsSearchHit[] | WikiOpsReadFail>;
  readonly reindex?: (input: { readonly path?: string; readonly force?: boolean }) => Promise<void>;
}

export interface ManifestSection {
  readonly heading: string;
  readonly include_subsections?: boolean;
}

export interface ManifestEdge {
  readonly type: string;
  readonly target: string;
}

export interface ManifestEpisode {
  readonly episode_id: string;
  readonly title: string;
  readonly path: string;
  readonly sections: readonly ManifestSection[];
  readonly aliases?: readonly string[];
  readonly topic?: string;
  readonly role?: string;
  readonly edges?: readonly ManifestEdge[];
  readonly referenced_paths?: readonly string[];
}

export interface OpsWikiManifest {
  readonly schema_version: 1;
  readonly source_repo: string;
  readonly max_episode_bytes: number;
  readonly weak_top1_score: number;
  readonly ambiguity_max_score_delta: number;
  readonly exclusions?: readonly string[];
  readonly episodes: readonly ManifestEpisode[];
}

export interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly expected_episode_ids: readonly string[];
}

export interface GoldenSuite {
  readonly queries: readonly GoldenQuery[];
}

export interface RenderedEpisode {
  readonly episode_id: string;
  readonly relativePath: string;
  readonly title: string;
  readonly markdown: string;
  readonly body: string;
  readonly sourcePath: string;
  readonly sourceSections: readonly string[];
  readonly sourceHash: string;
  readonly extractionHash: string;
  readonly generationHash: string;
  readonly aliases: readonly string[];
  readonly topic?: string;
  readonly role?: string;
  readonly edges: readonly ManifestEdge[];
  readonly referencedPaths: readonly string[];
}

export type FreshnessDecision = 'use_wiki_ops' | 'canonical_files';
export type SearchEscalation = 'read_top1' | 'expand';

export type OpsWikiOkStatus = 'no_op' | 'applied' | 'status_only' | 'checked';
export interface OpsWikiSuccess {
  readonly ok: true;
  readonly status: OpsWikiOkStatus;
  readonly commit: string;
  readonly searchable: boolean;
  readonly changedEpisodeIds: readonly string[];
  readonly removedEpisodeIds: readonly string[];
  readonly detail: string;
}

export interface OpsWikiDegraded {
  readonly ok: false;
  readonly status: 'degraded';
  readonly commit: string;
  readonly searchable: false;
  readonly reason: string;
  readonly checkedThrough?: string;
  readonly applyInProgress?: string;
  readonly mutationBegan: boolean;
}

export type OpsWikiResult = OpsWikiSuccess | OpsWikiDegraded;

export interface SyncOptions {
  readonly repoRoot: string;
  readonly commitRef: string;
  readonly corpusRoot?: string;
  readonly syntoVault?: string;
  readonly manifestPath?: string;
  readonly goldenPath?: string;
  readonly client?: WikiOpsClient;
  readonly git?: GitRunner;
  readonly reindex?: ReindexMode;
  readonly convergenceTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

const EPISODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const HEADING_PATTERN = /^(#{1,6}) (.+)$/u;

export function defaultGitRunner(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcessSync({ command: 'git', args: [...args], cwd, inheritParentEnv: true });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function resolveCommit(repoRoot: string, ref: string, git: GitRunner = defaultGitRunner): string {
  const result = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (!result.ok || !COMMIT_PATTERN.test(sha)) throw new Error(`ops_wiki_commit_unresolved:${ref}`);
  return sha;
}

export function readCommitText(
  repoRoot: string,
  commit: string,
  relativePath: string,
  git: GitRunner = defaultGitRunner,
): string {
  assertRepoRelative(relativePath);
  const result = git(repoRoot, ['cat-file', 'blob', `${commit}:${relativePath}`]);
  if (!result.ok) throw new Error(`ops_wiki_missing_path:${relativePath}`);
  return result.stdout;
}

export function commitPathExists(
  repoRoot: string,
  commit: string,
  relativePath: string,
  git: GitRunner = defaultGitRunner,
): boolean {
  assertRepoRelative(relativePath);
  return git(repoRoot, ['cat-file', '-e', `${commit}:${relativePath}`]).ok;
}

function assertRepoRelative(relativePath: string): void {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split(/[\\/]/u).includes('..')) {
    throw new Error(`ops_wiki_path_escape:${relativePath || '<missing>'}`);
  }
}

function readControlText(
  options: SyncOptions,
  commit: string,
  relativePath: string,
  explicitPath: string | undefined,
  git: GitRunner,
): string {
  if (explicitPath) return readFileSync(explicitPath, 'utf8');
  return readCommitText(options.repoRoot, commit, relativePath, git);
}

export function loadManifest(raw: string): OpsWikiManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ops_wiki_manifest_malformed:json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ops_wiki_manifest_malformed:object');
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error('ops_wiki_manifest_malformed:schema_version');
  if (typeof record.source_repo !== 'string' || !record.source_repo.trim()) throw new Error('ops_wiki_manifest_malformed:source_repo');
  if (record.max_episode_bytes !== 12288) throw new Error('ops_wiki_manifest_malformed:max_episode_bytes');
  if (record.weak_top1_score !== 0.5) throw new Error('ops_wiki_manifest_malformed:weak_top1_score');
  if (record.ambiguity_max_score_delta !== 0.05) throw new Error('ops_wiki_manifest_malformed:ambiguity_max_score_delta');
  if (!Array.isArray(record.episodes) || record.episodes.length === 0) throw new Error('ops_wiki_manifest_malformed:episodes');

  const episodes = record.episodes.map((item, index) => parseEpisode(item, index));
  const ids = new Set<string>();
  for (const episode of episodes) {
    if (ids.has(episode.episode_id)) throw new Error(`ops_wiki_manifest_malformed:duplicate_episode:${episode.episode_id}`);
    ids.add(episode.episode_id);
  }
  for (const episode of episodes) {
    for (const edge of episode.edges ?? []) {
      if (!ids.has(edge.target)) throw new Error(`ops_wiki_manifest_malformed:edge_target:${episode.episode_id}:${edge.target}`);
      if (edge.type === 'related') {
        const target = episodes.find((candidate) => candidate.episode_id === edge.target);
        if (!(target?.edges ?? []).some((candidate) => candidate.type === 'related' && candidate.target === episode.episode_id)) {
          throw new Error(`ops_wiki_manifest_malformed:asymmetric_related:${episode.episode_id}:${edge.target}`);
        }
      }
    }
  }

  return {
    schema_version: 1,
    source_repo: record.source_repo.trim(),
    max_episode_bytes: 12288,
    weak_top1_score: 0.5,
    ambiguity_max_score_delta: 0.05,
    exclusions: Array.isArray(record.exclusions) ? record.exclusions.map((item) => String(item)) : [],
    episodes,
  };
}

function parseEpisode(item: unknown, index: number): ManifestEpisode {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`ops_wiki_manifest_malformed:episode:${index}`);
  const record = item as Record<string, unknown>;
  const episodeId = String(record.episode_id ?? '').trim();
  if (!EPISODE_ID_PATTERN.test(episodeId)) throw new Error(`ops_wiki_manifest_malformed:episode_id:${episodeId || index}`);
  const title = String(record.title ?? '').trim();
  const path = String(record.path ?? '').trim();
  if (!title || !path) throw new Error(`ops_wiki_manifest_malformed:episode_fields:${episodeId}`);
  assertRepoRelative(path);
  if (!Array.isArray(record.sections) || record.sections.length === 0) {
    throw new Error(`ops_wiki_manifest_malformed:sections:${episodeId}`);
  }

  const sections = record.sections.map((section, sectionIndex) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`ops_wiki_manifest_malformed:section:${episodeId}:${sectionIndex}`);
    }
    const sectionRecord = section as Record<string, unknown>;
    const heading = String(sectionRecord.heading ?? '').trim();
    if (!HEADING_PATTERN.test(heading)) throw new Error(`ops_wiki_unresolved_selector:${path}:${heading || '<missing>'}`);
    return { heading, include_subsections: sectionRecord.include_subsections !== false };
  });

  const referencedPaths = Array.isArray(record.referenced_paths)
    ? record.referenced_paths.map((value) => {
      const referencedPath = String(value).trim();
      assertRepoRelative(referencedPath);
      return referencedPath;
    })
    : [];

  const edges = Array.isArray(record.edges)
    ? record.edges.map((edge) => {
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new Error(`ops_wiki_manifest_malformed:edge:${episodeId}`);
      const edgeRecord = edge as Record<string, unknown>;
      const type = String(edgeRecord.type ?? '').trim();
      const target = String(edgeRecord.target ?? '').trim();
      if (!type || !target) throw new Error(`ops_wiki_manifest_malformed:edge:${episodeId}`);
      return { type, target };
    })
    : [];

  return {
    episode_id: episodeId,
    title,
    path,
    sections,
    aliases: Array.isArray(record.aliases) ? record.aliases.map((value) => String(value)) : [],
    topic: typeof record.topic === 'string' ? record.topic : undefined,
    role: typeof record.role === 'string' ? record.role : undefined,
    edges,
    referenced_paths: referencedPaths,
  };
}

export function loadGoldenSuite(raw: string): GoldenSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ops_wiki_golden_malformed:json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ops_wiki_golden_malformed:object');
  const queriesRaw = (parsed as { queries?: unknown }).queries;
  if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) throw new Error('ops_wiki_golden_malformed');
  const queries = queriesRaw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`ops_wiki_golden_malformed:${index}`);
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? '').trim();
    const query = String(record.query ?? '').trim();
    const expected = Array.isArray(record.expected_episode_ids)
      ? record.expected_episode_ids.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!id || !query || expected.length === 0) throw new Error(`ops_wiki_golden_malformed:${id || index}`);
    return { id, query, expected_episode_ids: expected };
  });
  return { queries };
}

interface HeadingHit {
  readonly level: number;
  readonly title: string;
  readonly token: string;
  readonly line: number;
}

export function collectHeadings(text: string): readonly HeadingHit[] {
  const lines = text.split('\n');
  let fence: '`' | '~' | undefined;
  const hits: HeadingHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const kind = fenceMatch[1]![0] as '`' | '~';
      if (!fence) fence = kind;
      else if (fence === kind) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = HEADING_PATTERN.exec(line);
    if (!match) continue;
    hits.push({ level: match[1]!.length, title: match[2]!, token: match[0], line: index });
  }
  return hits;
}

export function extractSection(text: string, heading: string, includeSubsections = true): string {
  const lines = text.split('\n');
  const hits = collectHeadings(text);
  const matches = hits.filter((hit) => hit.token === heading);
  if (matches.length === 0) throw new Error(`ops_wiki_unresolved_selector:${heading}`);
  if (matches.length > 1) throw new Error(`ops_wiki_ambiguous_selector:${heading}`);
  const start = matches[0]!;
  let end = lines.length;
  for (const candidate of hits) {
    if (candidate.line <= start.line) continue;
    if (includeSubsections ? candidate.level <= start.level : true) {
      end = candidate.line;
      break;
    }
  }
  return lines.slice(start.line, end).join('\n').replace(/\n+$/u, '');
}

export function episodeRelativePath(episodeId: string): string {
  return `${OPS_WIKI_EPISODE_DIR}/${episodeId}.md`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function renderFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          lines.push(`  - type: ${yamlScalar(String(record.type))}`);
          lines.push(`    target: ${yamlScalar(String(record.target))}`);
        } else {
          lines.push(`  - ${yamlScalar(String(item))}`);
        }
      }
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    lines.push(`${key}: ${yamlScalar(String(value))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseOwnedFrontmatter(markdown: string): Record<string, string> | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields.ops_wiki_owned === 'true' ? fields : undefined;
}

function markdownBodyAfterFrontmatter(markdown: string): string | undefined {
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/u.exec(markdown);
  return match ? markdown.slice(match[0].length) : undefined;
}

function parseBodyJsonBlock(markdown: string, language: string): Record<string, unknown> | undefined {
  const escapedLanguage = language.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp('(?:^|\\n)```' + escapedLanguage + '\\n([^\\n]*)\\n```(?:\\n|$)', 'u').exec(markdown);
  if (!match) return undefined;
  const parsed: unknown = JSON.parse(match[1]!);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ops_wiki_body_block_malformed');
  return parsed as Record<string, unknown>;
}

function parseStatusFields(fields: Record<string, unknown>): { checkedThrough?: string; applyInProgress?: string } {
  const checkedThrough = fields.checked_through_commit;
  const applyInProgress = fields.apply_in_progress;
  if (checkedThrough !== undefined && (typeof checkedThrough !== 'string' || !COMMIT_PATTERN.test(checkedThrough))) {
    throw new Error('ops_wiki_status_malformed');
  }
  if (applyInProgress !== undefined && (typeof applyInProgress !== 'string' || !COMMIT_PATTERN.test(applyInProgress))) {
    throw new Error('ops_wiki_status_malformed');
  }
  return {
    checkedThrough: checkedThrough as string | undefined,
    applyInProgress: applyInProgress as string | undefined,
  };
}

function renderBodyJsonBlock(language: string, value: Record<string, unknown>): string {
  return ['```' + language, JSON.stringify(value), '```'].join('\n');
}

export function parseStatusNote(markdown: string): { checkedThrough?: string; applyInProgress?: string } {
  const fields = parseOwnedFrontmatter(markdown);
  if (fields && fields.ops_wiki_kind !== 'status') throw new Error('ops_wiki_status_malformed');
  let frontmatterStatus: { checkedThrough?: string; applyInProgress?: string } | undefined;
  if (fields) frontmatterStatus = parseStatusFields(fields);
  let bodyStatus: { checkedThrough?: string; applyInProgress?: string } | undefined;
  try {
    const bodyFields = parseBodyJsonBlock(markdown, 'ops-wiki-status');
    if (bodyFields) bodyStatus = parseStatusFields(bodyFields);
  } catch {
    throw new Error('ops_wiki_status_malformed');
  }
  if (!frontmatterStatus && !bodyStatus) throw new Error('ops_wiki_status_malformed');
  if (frontmatterStatus && bodyStatus && (frontmatterStatus.checkedThrough !== bodyStatus.checkedThrough || frontmatterStatus.applyInProgress !== bodyStatus.applyInProgress)) {
    throw new Error('ops_wiki_status_malformed');
  }
  return bodyStatus ?? frontmatterStatus!;
}

export function renderStatusNote(input: { readonly checkedThrough?: string; readonly applyInProgress?: string }): string {
  const body = renderBodyJsonBlock('ops-wiki-status', {
    checked_through_commit: input.checkedThrough,
    apply_in_progress: input.applyInProgress,
  });
  return `${renderFrontmatter({
    ops_wiki_owned: true,
    ops_wiki_kind: 'status',
    checked_through_commit: input.checkedThrough,
    apply_in_progress: input.applyInProgress,
  })}\n\n# Ops Wiki Status\n\n${body}\n`;
}

function renderNavigation(edges: readonly ManifestEdge[]): string {
  if (edges.length === 0) return '';
  const lines = ['', '## Related episodes', ''];
  for (const edge of edges) lines.push(`- ${edge.type}: [[${episodeRelativePath(edge.target).replace(/\.md$/u, '')}]]`);
  return `${lines.join('\n')}\n`;
}

function generationHashFor(
  manifest: OpsWikiManifest,
  episode: ManifestEpisode,
  extractionHash: string,
): string {
  return sha256(JSON.stringify({
    episode_id: episode.episode_id,
    title: episode.title,
    source_repo: manifest.source_repo,
    source_path: episode.path,
    source_sections: episode.sections.map((section) => section.heading),
    extraction_hash: extractionHash,
    aliases: episode.aliases ?? [],
    topic: episode.topic ?? null,
    role: episode.role ?? null,
    edges: episode.edges ?? [],
  }));
}

export function renderEpisode(
  manifest: OpsWikiManifest,
  episode: ManifestEpisode,
  sourceText: string,
  commit: string,
): RenderedEpisode {
  const sourceSections = episode.sections.map((section) => section.heading);
  const parts = episode.sections.map((section) => extractSection(sourceText, section.heading, section.include_subsections !== false));
  const body = parts.join('\n\n');
  const sourceHash = sha256(sourceText);
  const extractionHash = sha256(body);
  const generationHash = generationHashFor(manifest, episode, extractionHash);
  const markdown = `${renderFrontmatter({
    ops_wiki_owned: true,
    ops_wiki_kind: 'episode',
    episode_id: episode.episode_id,
    title: episode.title,
    source_repo: manifest.source_repo,
    source_commit: commit,
    source_path: episode.path,
    source_sections: sourceSections,
    source_hash: sourceHash,
    extraction_hash: extractionHash,
    generation_hash: generationHash,
    aliases: episode.aliases ?? [],
    topic: episode.topic,
    role: episode.role,
    edges: episode.edges ?? [],
  })}\n\n${renderBodyJsonBlock('ops-wiki-episode', {
    episode_id: episode.episode_id,
    source_commit: commit,
    generation_hash: generationHash,
  })}\n\n${body}${renderNavigation(episode.edges ?? [])}`;
  const bytes = Buffer.byteLength(markdown);
  if (bytes > manifest.max_episode_bytes) throw new Error(`ops_wiki_episode_over_byte_ceiling:${episode.episode_id}:${bytes}`);
  return {
    episode_id: episode.episode_id,
    relativePath: episodeRelativePath(episode.episode_id),
    title: episode.title,
    markdown,
    body,
    sourcePath: episode.path,
    sourceSections,
    sourceHash,
    extractionHash,
    generationHash,
    aliases: episode.aliases ?? [],
    topic: episode.topic,
    role: episode.role,
    edges: episode.edges ?? [],
    referencedPaths: episode.referenced_paths ?? [],
  };
}

export function planEpisodes(
  repoRoot: string,
  commit: string,
  manifest: OpsWikiManifest,
  git: GitRunner = defaultGitRunner,
): readonly RenderedEpisode[] {
  const rendered: RenderedEpisode[] = [];
  for (const episode of manifest.episodes) {
    const sourceText = readCommitText(repoRoot, commit, episode.path, git);
    rendered.push(renderEpisode(manifest, episode, sourceText, commit));
    for (const referenced of episode.referenced_paths ?? []) {
      if (!commitPathExists(repoRoot, commit, referenced, git)) {
        throw new Error(`ops_wiki_missing_referenced_path:${episode.episode_id}:${referenced}`);
      }
    }
  }
  return rendered;
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function isDotEntry(name: string): boolean {
  return name.startsWith('.');
}

export function listMarkdownFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (isDotEntry(entry)) continue;
      const absolute = join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute);
      else if (entry.endsWith('.md')) files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

export function assertCorpusLocation(corpusRoot: string, syntoVault?: string): void {
  const resolvedCorpus = resolve(corpusRoot);
  if (!syntoVault) return;
  const resolvedSynto = resolve(syntoVault);
  if (resolvedCorpus === resolvedSynto || resolvedCorpus.startsWith(`${resolvedSynto}${sep}`)) {
    throw new Error(`ops_wiki_synto_vault_rejected:${corpusRoot}`);
  }
}

function corpusNotePath(corpusRoot: string, relativePath: string): string {
  assertRepoRelative(relativePath);
  const resolvedRoot = resolve(corpusRoot);
  const target = resolve(corpusRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`ops_wiki_path_escape:${relativePath}`);
  return target;
}

function readCorpusStatus(corpusRoot: string): { checkedThrough?: string; applyInProgress?: string } | undefined {
  const path = join(corpusRoot, OPS_WIKI_STATUS_NOTE);
  if (!existsSync(path)) return undefined;
  return parseStatusNote(readFileSync(path, 'utf8'));
}

function restorePriorStatus(
  corpusRoot: string,
  previous: { checkedThrough?: string; applyInProgress?: string } | undefined,
): void {
  const statusPath = join(corpusRoot, OPS_WIKI_STATUS_NOTE);
  if (!previous) {
    rmSync(statusPath, { force: true });
    return;
  }
  atomicWrite(statusPath, renderStatusNote(previous));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function probeWithin<T>(probe: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
): Promise<T | undefined> {
  const deadline = now() + Math.max(0, timeoutMs);
  while (now() <= deadline) {
    const remaining = Math.max(0, deadline - now());
    const value = await probeWithin(probe, Math.max(1, remaining));
    if (value !== undefined) return value;
    if (now() >= deadline || now() + pollIntervalMs > deadline) break;
    await sleep(pollIntervalMs);
  }
  return undefined;
}

function statusFromRead(read: WikiOpsReadResult): { checkedThrough?: string; applyInProgress?: string } | WikiOpsReadFail {
  if (read.ok === false) return read;
  try {
    return parseStatusNote(read.content);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export function evaluateOperationalFreshness(input: {
  readonly currentCommit: string;
  readonly read: WikiOpsReadResult;
}): FreshnessDecision {
  if (!input.read.ok) return 'canonical_files';
  try {
    const status = parseStatusNote(input.read.content);
    return !status.applyInProgress && status.checkedThrough === input.currentCommit ? 'use_wiki_ops' : 'canonical_files';
  } catch {
    return 'canonical_files';
  }
}

export function evaluateSearchEscalation(
  hits: readonly WikiOpsSearchHit[],
  policy: { readonly weak_top1_score: number; readonly ambiguity_max_score_delta: number },
): SearchEscalation {
  if (hits.length === 0) return 'expand';
  const top1 = hits[0]!.score;
  if (typeof top1 !== 'number' || !Number.isFinite(top1) || top1 < policy.weak_top1_score) return 'expand';
  const top2 = hits[1]?.score;
  if (typeof top2 === 'number' && top2 >= policy.weak_top1_score && top1 - top2 < policy.ambiguity_max_score_delta) return 'expand';
  return 'read_top1';
}

export function evaluateEpisodeRead(input: {
  readonly read: WikiOpsReadResult;
  readonly episode: RenderedEpisode;
}): SearchEscalation {
  if (!input.read.ok || !input.read.content.trim()) return 'expand';
  const body = markdownBodyAfterFrontmatter(input.read.content) ?? input.read.content;
  let identity: Record<string, unknown> | undefined;
  try {
    identity = parseBodyJsonBlock(body, 'ops-wiki-episode');
  } catch {
    return 'expand';
  }
  if (!identity || identity.episode_id !== input.episode.episode_id) return 'expand';
  if (typeof identity.source_commit !== 'string' || !COMMIT_PATTERN.test(identity.source_commit)) return 'expand';
  if (identity.generation_hash !== input.episode.generationHash) return 'expand';
  const headings = new Set(collectHeadings(body).map((hit) => hit.token));
  for (const section of input.episode.sourceSections) {
    if (!headings.has(section)) return 'expand';
  }
  return 'read_top1';
}

const PROCEDURE_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/воркер|worker/iu, 'worker lifecycle pre-flight'],
  [/менеджер|manager/iu, 'manager supervised task launch'],
  [/пожарн|firefighter|smoke/iu, 'worker smoke testing'],
  [/мерж|merge|adoption/iu, 'merge with local adoption'],
  [/ревью|review/iu, 'pack review current-head'],
  [/wiki-ops|операционн/iu, 'ops wiki sync checked_through_commit'],
];

export function buildEscalationQueries(query: string): readonly string[] {
  const trimmed = query.trim();
  const queries = [trimmed];
  for (const [pattern, phrase] of PROCEDURE_SYNONYMS) {
    if (pattern.test(trimmed) && !queries.includes(phrase)) queries.push(phrase);
  }
  if (/[А-Яа-яЁё]/u.test(trimmed)) queries.push(`${trimmed} orchestrator-pack procedure`);
  else queries.push(`${trimmed} процедура оркестратора`);
  const identifier = trimmed.match(/#[0-9]+|scripts\/[\w./-]+|PACK_[A-Z0-9_]+/u)?.[0];
  if (identifier) queries.push(identifier);
  const unique = [...new Set(queries.map((item) => item.trim()).filter(Boolean))];
  if (unique.length < 2) unique.push(`${trimmed} procedure`);
  return unique.slice(0, 4);
}

function existingEpisodeState(corpusRoot: string): Readonly<Record<string, string>> {
  const dir = join(corpusRoot, OPS_WIKI_EPISODE_DIR);
  if (!existsSync(dir)) return {};
  const state: Record<string, string> = {};
  for (const file of listMarkdownFiles(dir)) {
    const markdown = readFileSync(file, 'utf8');
    const fields = parseOwnedFrontmatter(markdown);
    if (fields?.episode_id) state[fields.episode_id] = markdown;
  }
  return state;
}

function ownedRelativePaths(corpusRoot: string): readonly string[] {
  const owned: string[] = [];
  for (const file of listMarkdownFiles(corpusRoot)) {
    if (!parseOwnedFrontmatter(readFileSync(file, 'utf8'))) continue;
    owned.push(relative(corpusRoot, file).split(sep).join('/'));
  }
  return owned;
}

async function readIndexStatus(client: WikiOpsClient): Promise<WikiOpsReadResult> {
  try {
    return await client.read(OPS_WIKI_STATUS_NOTE, { related: false });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

async function waitForStatus(
  client: WikiOpsClient,
  expected: { readonly checkedThrough?: string; readonly applyInProgress?: string | null },
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
): Promise<WikiOpsReadResult> {
  let lastFailure: WikiOpsReadFail | undefined;
  const matched = await waitFor(async () => {
    const read = await readIndexStatus(client);
    if (read.ok === false) {
      lastFailure = read;
      return undefined;
    }
    const status = statusFromRead(read);
    if ('ok' in status && status.ok === false) {
      lastFailure = status;
      return undefined;
    }
    const parsed = status as { checkedThrough?: string; applyInProgress?: string };
    const checkedOk = parsed.checkedThrough === expected.checkedThrough;
    const expectedProgress = expected.applyInProgress ?? undefined;
    const progressOk = parsed.applyInProgress === expectedProgress;
    return checkedOk && progressOk ? read : undefined;
  }, timeoutMs, pollIntervalMs, now);
  return matched ?? lastFailure ?? { ok: false, reason: 'timeout' };
}

async function waitForEpisodeBytes(
  client: WikiOpsClient,
  relativePath: string,
  expected: string,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
): Promise<boolean> {
  const expectedBody = markdownBodyAfterFrontmatter(expected);
  if (expectedBody === undefined) return false;
  const matched = await waitFor(async () => {
    try {
      const read = await client.read(relativePath, { related: false });
      return read.ok && read.content === expectedBody ? true : undefined;
    } catch {
      return undefined;
    }
  }, timeoutMs, pollIntervalMs, now);
  return matched === true;
}

async function waitForEpisodeAbsent(
  client: WikiOpsClient,
  relativePath: string,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
): Promise<boolean> {
  const matched = await waitFor(async () => {
    try {
      const read = await client.read(relativePath, { related: false });
      return read.ok === false && read.reason === 'absent' ? true : undefined;
    } catch {
      return undefined;
    }
  }, timeoutMs, pollIntervalMs, now);
  return matched === true;
}

function episodeIdFromPath(relativePath: string): string | undefined {
  return /^episodes\/([a-z0-9][a-z0-9-]*)\.md$/u.exec(relativePath)?.[1];
}

export async function runGoldenSuite(
  client: WikiOpsClient,
  suite: GoldenSuite,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  for (const query of suite.queries) {
    let hits: WikiOpsSearchHit[] | WikiOpsReadFail;
    try {
      hits = await client.search({ query: query.query, mode: 'hybrid', limit: 3 });
    } catch {
      return { ok: false, reason: `golden_unavailable:${query.id}` };
    }
    if (!Array.isArray(hits)) return { ok: false, reason: `golden_unavailable:${query.id}` };
    const found = new Set(hits.slice(0, 3).map((hit) => episodeIdFromPath(hit.path) ?? hit.path));
    if (!query.expected_episode_ids.every((episodeId) => found.has(episodeId))) {
      return { ok: false, reason: `golden_miss:${query.id}` };
    }
  }
  return { ok: true };
}

export function reconcileOwnedNotes(corpusRoot: string, keep: ReadonlySet<string>): readonly string[] {
  const removed: string[] = [];
  for (const relativePath of ownedRelativePaths(corpusRoot)) {
    if (keep.has(relativePath)) continue;
    rmSync(corpusNotePath(corpusRoot, relativePath), { force: true });
    removed.push(relativePath);
  }
  return removed;
}

function loadTrackedInputs(options: SyncOptions, commit: string, git: GitRunner): {
  manifest: OpsWikiManifest;
  golden: GoldenSuite;
} {
  const manifest = loadManifest(readControlText(options, commit, OPS_WIKI_MANIFEST_RELATIVE, options.manifestPath, git));
  const golden = loadGoldenSuite(readControlText(options, commit, OPS_WIKI_GOLDEN_RELATIVE, options.goldenPath, git));
  const ids = new Set(manifest.episodes.map((episode) => episode.episode_id));
  for (const query of golden.queries) {
    for (const episodeId of query.expected_episode_ids) {
      if (!ids.has(episodeId)) throw new Error(`ops_wiki_golden_unknown_episode:${query.id}:${episodeId}`);
    }
  }
  return { manifest, golden };
}

export function checkRepositoryMode(options: SyncOptions): OpsWikiResult {
  const git = options.git ?? defaultGitRunner;
  const commit = resolveCommit(options.repoRoot, options.commitRef, git);
  const { manifest } = loadTrackedInputs(options, commit, git);
  const rendered = planEpisodes(options.repoRoot, commit, manifest, git);
  return {
    ok: true,
    status: 'checked',
    commit,
    searchable: false,
    changedEpisodeIds: rendered.map((episode) => episode.episode_id),
    removedEpisodeIds: [],
    detail: `episodes=${rendered.length}`,
  };
}

export async function planOpsWiki(options: SyncOptions): Promise<OpsWikiResult> {
  return checkRepositoryMode(options);
}

function degraded(
  commit: string,
  reason: string,
  extras: { checkedThrough?: string; applyInProgress?: string; mutationBegan: boolean },
): OpsWikiDegraded {
  return { ok: false, status: 'degraded', commit, searchable: false, reason, ...extras };
}

export async function applyOpsWiki(options: SyncOptions): Promise<OpsWikiResult> {
  const git = options.git ?? defaultGitRunner;
  const commit = resolveCommit(options.repoRoot, options.commitRef, git);
  const corpusRoot = options.corpusRoot;
  if (!corpusRoot) return degraded(commit, 'ops_wiki_corpus_root_missing', { mutationBegan: false });
  try {
    assertCorpusLocation(corpusRoot, options.syntoVault ?? process.env.PACK_SYNTO_VAULT);
  } catch (error) {
    return degraded(commit, error instanceof Error ? error.message : String(error), { mutationBegan: false });
  }
  const client = options.client;
  if (!client) return degraded(commit, 'ops_wiki_client_missing', { mutationBegan: false });

  const timeoutRaw = options.convergenceTimeoutMs ?? Number(process.env.PACK_OPS_WIKI_CONVERGENCE_TIMEOUT_MS ?? DEFAULT_CONVERGENCE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_CONVERGENCE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let manifest: OpsWikiManifest;
  let golden: GoldenSuite;
  let rendered: readonly RenderedEpisode[];
  try {
    ({ manifest, golden } = loadTrackedInputs(options, commit, git));
    rendered = planEpisodes(options.repoRoot, commit, manifest, git);
  } catch (error) {
    return degraded(commit, error instanceof Error ? error.message : String(error), { mutationBegan: false });
  }

  mkdirSync(corpusRoot, { recursive: true });
  let previous: { checkedThrough?: string; applyInProgress?: string } | undefined;
  let existing: Readonly<Record<string, string>>;
  try {
    previous = readCorpusStatus(corpusRoot);
    existing = existingEpisodeState(corpusRoot);
  } catch (error) {
    return degraded(commit, error instanceof Error ? error.message : String(error), { mutationBegan: false });
  }

  const changed = rendered.filter((episode) => {
    const previousMarkdown = existing[episode.episode_id];
    if (!previousMarkdown) return true;
    return parseOwnedFrontmatter(previousMarkdown)?.generation_hash !== episode.generationHash;
  });
  const keep = new Set([OPS_WIKI_STATUS_NOTE, ...rendered.map((episode) => episode.relativePath)]);
  const obsolete = ownedRelativePaths(corpusRoot).filter((path) => !keep.has(path) && path !== OPS_WIKI_STATUS_NOTE);
  const removedIds = obsolete.map((path) => episodeIdFromPath(path)).filter((value): value is string => Boolean(value));

  if (previous?.checkedThrough === commit && !previous.applyInProgress && changed.length === 0 && obsolete.length === 0) {
    return {
      ok: true,
      status: 'no_op',
      commit,
      searchable: true,
      changedEpisodeIds: [],
      removedEpisodeIds: [],
      detail: 'already checked through commit',
    };
  }

  const inProgressNote = renderStatusNote({ checkedThrough: previous?.checkedThrough, applyInProgress: commit });
  atomicWrite(join(corpusRoot, OPS_WIKI_STATUS_NOTE), inProgressNote);
  const inProgressRead = await waitForStatus(
    client,
    { checkedThrough: previous?.checkedThrough, applyInProgress: commit },
    timeoutMs,
    pollIntervalMs,
    now,
  );
  if (inProgressRead.ok === false) {
    restorePriorStatus(corpusRoot, previous);
    return degraded(commit, `ops_wiki_in_progress_unconfirmed:${inProgressRead.reason}`, {
      checkedThrough: previous?.checkedThrough,
      applyInProgress: previous?.applyInProgress,
      mutationBegan: false,
    });
  }

  let mutationBegan = false;
  const failAfterFence = (reason: string): OpsWikiDegraded => {
    if (!mutationBegan) restorePriorStatus(corpusRoot, previous);
    return degraded(commit, reason, {
      checkedThrough: previous?.checkedThrough,
      applyInProgress: mutationBegan ? commit : previous?.applyInProgress,
      mutationBegan,
    });
  };

  try {
    for (const episode of changed) {
      mutationBegan = true;
      atomicWrite(corpusNotePath(corpusRoot, episode.relativePath), episode.markdown);
    }
    if (obsolete.length > 0) {
      mutationBegan = true;
      reconcileOwnedNotes(corpusRoot, keep);
    }
  } catch (error) {
    return failAfterFence(error instanceof Error ? error.message : String(error));
  }

  if (options.reindex) {
    if (!client.reindex) return failAfterFence('ops_wiki_reindex_unavailable');
    try {
      await client.reindex({ force: options.reindex === 'full' });
    } catch {
      return failAfterFence('ops_wiki_reindex_unavailable');
    }
  }

  for (const episode of changed) {
    const ok = await waitForEpisodeBytes(client, episode.relativePath, episode.markdown, timeoutMs, pollIntervalMs, now);
    if (!ok) return failAfterFence(`ops_wiki_episode_readback_failed:${episode.episode_id}`);
  }
  for (const relativePath of obsolete) {
    const ok = await waitForEpisodeAbsent(client, relativePath, timeoutMs, pollIntervalMs, now);
    if (!ok) return failAfterFence(`ops_wiki_removal_readback_failed:${relativePath}`);
  }

  const goldenResult = await runGoldenSuite(client, golden);
  if (goldenResult.ok === false) return failAfterFence(goldenResult.reason);

  atomicWrite(join(corpusRoot, OPS_WIKI_STATUS_NOTE), renderStatusNote({ checkedThrough: commit }));
  const finalRead = await waitForStatus(client, { checkedThrough: commit, applyInProgress: null }, timeoutMs, pollIntervalMs, now);
  if (finalRead.ok === false) {
    if (mutationBegan) atomicWrite(join(corpusRoot, OPS_WIKI_STATUS_NOTE), inProgressNote);
    else restorePriorStatus(corpusRoot, previous);
    return degraded(commit, `ops_wiki_final_status_unconfirmed:${finalRead.reason}`, {
      checkedThrough: previous?.checkedThrough,
      applyInProgress: mutationBegan ? commit : previous?.applyInProgress,
      mutationBegan,
    });
  }

  return {
    ok: true,
    status: changed.length === 0 && obsolete.length === 0 ? 'status_only' : 'applied',
    commit,
    searchable: true,
    changedEpisodeIds: changed.map((episode) => episode.episode_id),
    removedEpisodeIds: removedIds,
    detail: `changed=${changed.length} removed=${removedIds.length}`,
  };
}

function parseSseOrJson(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  if (dataLines.length === 0) throw new Error('ops_wiki_mcp_malformed');
  return JSON.parse(dataLines[0]!);
}

function jsonToolResult(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (record.isError === true) {
    const text = Array.isArray(record.content)
      ? record.content.map((item) => item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '').join('\n')
      : '';
    throw new Error(text || 'ops_wiki_mcp_tool_error');
  }
  if (!Array.isArray(record.content)) return payload;
  for (const item of record.content) {
    if (!item || typeof item !== 'object' || !('text' in item)) continue;
    const text = String((item as { text: unknown }).text).trim();
    if (!text) continue;
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  }
  return payload;
}

function isTimeoutError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error && String((error as { name?: unknown }).name) === 'TimeoutError') return true;
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes('timeout');
}

export function createMcpWikiOpsClient(
  url: string,
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
): WikiOpsClient {
  let nextId = 1;
  const boundedTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? requestTimeoutMs
    : DEFAULT_MCP_REQUEST_TIMEOUT_MS;

  const rpc = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      signal: AbortSignal.timeout(boundedTimeout),
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`ops_wiki_mcp_http_${response.status}:${body.slice(0, 200)}`);
    const parsed = parseSseOrJson(body) as { error?: { message?: string }; result?: unknown };
    if (parsed.error) throw new Error(parsed.error.message ?? 'ops_wiki_mcp_error');
    return parsed.result;
  };

  const ready = rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'orchestrator-pack-sync-ops-wiki', version: '1' },
  }).then(() => undefined);

  return {
    async read(path, options) {
      try {
        await ready;
        const result = jsonToolResult(await rpc('tools/call', {
          name: 'read',
          arguments: { paths: path, related: options?.related === true, snippet_length: 3000 },
        }));
        const container = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        const rows = Array.isArray(result)
          ? result
          : Array.isArray(container.results)
            ? container.results
            : Array.isArray(container.notes)
              ? container.notes
              : [];
        const note = rows[0];
        if (!note || typeof note !== 'object') return { ok: false, reason: 'absent' };
        const record = note as Record<string, unknown>;
        if (record.found === false) return { ok: false, reason: 'absent' };
        const content = String(record.content ?? record.text ?? '');
        if (!content) return { ok: false, reason: 'absent' };
        return { ok: true, path: typeof record.path === 'string' ? record.path : path, content };
      } catch (error) {
        return { ok: false, reason: isTimeoutError(error) ? 'timeout' : 'unavailable' };
      }
    },
    async search(input) {
      try {
        await ready;
        const result = jsonToolResult(await rpc('tools/call', {
          name: 'search',
          arguments: {
            query: input.query,
            queries: input.queries,
            mode: input.mode ?? 'hybrid',
            limit: input.limit ?? 3,
          },
        }));
        const container = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        const rows = Array.isArray(result) ? result : Array.isArray(container.results) ? container.results : [];
        return rows.map((row) => {
          const record = row as Record<string, unknown>;
          return {
            path: String(record.path ?? ''),
            title: typeof record.title === 'string' ? record.title : undefined,
            score: typeof record.score === 'number' ? record.score : undefined,
            snippet: typeof record.snippet === 'string' ? record.snippet : undefined,
          };
        });
      } catch (error) {
        return { ok: false, reason: isTimeoutError(error) ? 'timeout' : 'unavailable' };
      }
    },
    async reindex(input) {
      await ready;
      await rpc('tools/call', { name: 'reindex', arguments: { path: input.path, force: input.force === true } });
    },
  };
}

export function createProductionWikiOpsClient(env: Readonly<NodeJS.ProcessEnv> = process.env): WikiOpsClient | undefined {
  const url = env.PACK_OPS_WIKI_MCP_URL?.trim();
  if (!url) return undefined;
  const convergence = Number(env.PACK_OPS_WIKI_CONVERGENCE_TIMEOUT_MS ?? DEFAULT_CONVERGENCE_TIMEOUT_MS);
  const requestTimeout = Number.isFinite(convergence) && convergence > 0
    ? Math.max(1, Math.min(DEFAULT_MCP_REQUEST_TIMEOUT_MS, convergence))
    : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  return createMcpWikiOpsClient(url, fetch, requestTimeout);
}

function printResult(result: OpsWikiResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.ok === true) {
    process.stdout.write(`[PASS] ${result.status} commit=${result.commit} ${result.detail}\n`);
    return;
  }
  process.stdout.write(`[DEGRADED] ${result.status} commit=${result.commit} ${result.reason}\n`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0] as OpsWikiMode | undefined;
  if (mode !== 'plan' && mode !== 'apply' && mode !== 'check') {
    process.stderr.write('usage: sync-ops-wiki.ts <plan|apply|check> --commit <ref> [--repo-root <path>] [--corpus-root <path>] [--synto-vault <path>] [--reindex incremental|full] [--json]\n');
    return 2;
  }
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const reindexValue = value('--reindex');
  if (reindexValue && reindexValue !== 'incremental' && reindexValue !== 'full') {
    process.stderr.write('[FAIL] --reindex must be incremental or full\n');
    return 2;
  }
  const repoRoot = resolve(value('--repo-root') ?? process.cwd());
  const options: SyncOptions = {
    repoRoot,
    commitRef: value('--commit') ?? '',
    corpusRoot: value('--corpus-root') ?? process.env.PACK_OPS_WIKI_CORPUS_ROOT,
    syntoVault: value('--synto-vault') ?? process.env.PACK_SYNTO_VAULT,
    reindex: reindexValue as ReindexMode | undefined,
    client: createProductionWikiOpsClient(),
  };
  if (!options.commitRef) {
    process.stderr.write('[FAIL] --commit is required\n');
    return 2;
  }
  try {
    const result = mode === 'apply' ? await applyOpsWiki(options) : checkRepositoryMode(options);
    printResult(result, argv.includes('--json'));
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`[FAIL] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) process.exitCode = await main(process.argv.slice(2));
