#!/usr/bin/env -S node --experimental-strip-types

import '../toolchain/native-entrypoint-preflight.ts';
import { constants as osConstants, tmpdir } from 'node:os';
import { runProcessSync } from '../kernel/subprocess.ts';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Manager-worktree `pre-push` guard (Issue #2732, B5).
 *
 * The installer gives one linked manager worktree a private hooks directory
 * (worktree-local `core.hooksPath`) whose stubs delegate every originally
 * effective hook. The `pre-push` stub runs this module first and only then the
 * original hook. This module owns exactly three new push denials:
 *   AC2 - a newly published manager-local commit that is not provably formatter-only,
 *   AC3 - any update/delete of the selected project's default branch,
 *   AC4 - an existing destination whose advertised OID lacks a verified fetched
 *         baseline for the same push endpoint, differs from it, or is not an
 *         ancestor of the proposed update.
 * Local accident prevention only: Git's hook bypass, a ref moving after the
 * observation, and a second `pushurl` endpoint are not solved here.
 */

const CONFIG_SECTION = 'opkManagerPushGuard';
const KEY = {
  installed: `${CONFIG_SECTION}.installed`,
  defaultBranch: `${CONFIG_SECTION}.defaultBranch`,
  originalHooksPath: `${CONFIG_SECTION}.originalHooksPath`,
  seedOid: `${CONFIG_SECTION}.seedOid`,
  seedEndpoint: `${CONFIG_SECTION}.seedEndpoint`,
} as const;
const GUARD_DIR_NAME = 'opk-manager-push-guard';
const ORIGINAL_HOOK_ENV = 'OPK_B5_ORIGINAL_HOOK';
const MAX_NEW_COMMITS = 500;
const MAX_PATCH_SOURCES = 64;
const PROOF_GIT = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false'] as const;
const ZERO_OID = /^0+$/u;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx)$/u;

/** Client-side hook names every manager stub delegates (plus any executable found in the original dir). */
const DELEGATED_HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-auto-gc', 'post-rewrite', 'reference-transaction', 'post-index-change',
] as const;

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[], input?: string | Uint8Array, env?: Readonly<NodeJS.ProcessEnv>,
  encoding?: BufferEncoding): GitResult {
  const result = runProcessSync({
    command: 'git', args, cwd, ...(input === undefined ? {} : { input }), ...(encoding ? { encoding } : {}),
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, inheritParentEnv: true,
  });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
}

function gitBlob(cwd: string, oid: string): string | null {
  const result = runProcessSync({ command: 'git', args: ['cat-file', 'blob', oid], cwd, inheritParentEnv: true });
  return result.ok ? result.stdout : null;
}

const trimmed = (value: string): string => value.trim();
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function worktreeConfig(cwd: string, key: string): string | null {
  const result = git(cwd, ['config', '--worktree', '--get', key]);
  return result.ok ? trimmed(result.stdout) : null;
}

/** Endpoint identity: effective URL, comparable across trivial spelling (never across protocols). */
export function normalizeEndpoint(url: string, cwd: string): string {
  let value = trimmed(url);
  if (value.startsWith('file://')) {
    try { value = fileURLToPath(value); } catch { return value; }
  }
  if (isAbsolute(value) || value.startsWith('.')) {
    const absolute = isAbsolute(value) ? value : resolve(cwd, value);
    try { return realpathSync(absolute); } catch { return absolute.replace(/\/+$/u, ''); }
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/iu.exec(value);
  if (match) {
    const path = (match[3] ?? '').replace(/\/+$/u, '').replace(/\.git$/u, '');
    return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}${path}`;
  }
  return value.replace(/\/+$/u, '').replace(/\.git$/u, '');
}

// ---------------------------------------------------------------------------
// Runtime: endpoint-to-tracking-ref resolution
// ---------------------------------------------------------------------------

interface Refspec {
  readonly negative: boolean;
  readonly src: string;
  readonly dst: string;
}

function parseRefspecs(cwd: string, remote: string): Refspec[] {
  const listed = git(cwd, ['config', '--get-all', `remote.${remote}.fetch`]);
  if (!listed.ok) return [];
  const specs: Refspec[] = [];
  for (const raw of listed.stdout.split('\n').map(trimmed).filter(Boolean)) {
    if (raw.startsWith('^')) {
      specs.push({ negative: true, src: raw.slice(1), dst: '' });
      continue;
    }
    const body = raw.startsWith('+') ? raw.slice(1) : raw;
    const colon = body.indexOf(':');
    if (colon <= 0 || colon === body.length - 1) continue;
    const src = body.slice(0, colon);
    const dst = body.slice(colon + 1);
    const srcStars = src.split('*').length - 1;
    const dstStars = dst.split('*').length - 1;
    if (srcStars > 1 || dstStars > 1 || srcStars !== dstStars) continue;
    specs.push({ negative: false, src, dst });
  }
  return specs;
}

function mapThroughRefspec(spec: Refspec, ref: string): string | null {
  const star = spec.src.indexOf('*');
  if (star < 0) return spec.src === ref ? spec.dst : null;
  const prefix = spec.src.slice(0, star);
  const suffix = spec.src.slice(star + 1);
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) return null;
  return spec.dst.replace('*', ref.slice(prefix.length, ref.length - suffix.length));
}

function negativeMatches(spec: Refspec, ref: string): boolean {
  return mapThroughRefspec({ negative: false, src: spec.src, dst: spec.src.includes('*') ? '*' : 'x' }, ref) !== null;
}

/** Remotes whose effective fetch URL is exactly the actual push endpoint. */
function verifiedFetchRemotes(cwd: string, pushEndpoint: string): string[] {
  const names = git(cwd, ['remote']);
  if (!names.ok) return [];
  const verified: string[] = [];
  for (const name of names.stdout.split('\n').map(trimmed).filter(Boolean)) {
    const urls = git(cwd, ['remote', 'get-url', '--all', name]);
    if (urls.ok && urls.stdout.split('\n').map(trimmed).filter(Boolean)
      .some((url) => normalizeEndpoint(url, cwd) === pushEndpoint)) verified.push(name);
  }
  return verified;
}

type TrackingResolution =
  | { readonly kind: 'ok'; readonly tracking: string }
  | { readonly kind: 'unverified'; readonly reason: string };

function resolveTrackingRef(cwd: string, remotes: readonly string[], remoteRef: string): TrackingResolution {
  if (remotes.length === 0) {
    return { kind: 'unverified', reason: 'no configured remote has an effective fetch URL equal to this push endpoint' };
  }
  const candidates = new Set<string>();
  for (const remote of remotes) {
    const specs = parseRefspecs(cwd, remote);
    if (specs.some((spec) => spec.negative && negativeMatches(spec, remoteRef))) {
      return { kind: 'unverified', reason: `a negative fetch refspec of remote ${remote} excludes ${remoteRef}` };
    }
    for (const spec of specs) {
      if (spec.negative) continue;
      const mapped = mapThroughRefspec(spec, remoteRef);
      if (mapped) candidates.add(mapped);
    }
  }
  if (candidates.size === 0) {
    return { kind: 'unverified', reason: `no positive fetch refspec of a same-endpoint remote maps ${remoteRef}` };
  }
  if (candidates.size > 1) {
    return { kind: 'unverified', reason: `ambiguous fetch mapping for ${remoteRef}: ${[...candidates].sort().join(', ')}` };
  }
  return { kind: 'ok', tracking: [...candidates][0]! };
}

/** Commit OIDs reachable evidence: every local tracking ref the same-endpoint remotes map. */
function publishedCommitOids(cwd: string, remotes: readonly string[]): string[] {
  const oids = new Set<string>();
  for (const remote of remotes) {
    for (const spec of parseRefspecs(cwd, remote)) {
      if (spec.negative) continue;
      const star = spec.dst.indexOf('*');
      const prefix = star < 0 ? spec.dst : spec.dst.slice(0, star);
      const listed = git(cwd, ['for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', prefix]);
      if (!listed.ok) continue;
      for (const line of listed.stdout.split('\n').map(trimmed).filter(Boolean)) {
        const [oid, type, name] = line.split(' ');
        if (!oid || type !== 'commit' || !name) continue;
        if (star < 0 ? name !== spec.dst : !(name.startsWith(prefix) && name.endsWith(spec.dst.slice(star + 1)))) continue;
        oids.add(oid);
      }
    }
  }
  return [...oids];
}

// ---------------------------------------------------------------------------
// Runtime: formatter equivalence (pack-owned TypeScript printer + token proof)
// ---------------------------------------------------------------------------

type TypeScriptModule = typeof import('typescript');
let typescriptModule: TypeScriptModule | null | undefined;

async function loadTypescript(): Promise<TypeScriptModule | null> {
  if (typescriptModule !== undefined) return typescriptModule;
  try {
    const packRoot = resolve(import.meta.dirname, '../..');
    const lock = JSON.parse(readFileSync(join(packRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    const locked = lock.packages?.['node_modules/typescript']?.version;
    const loaded = (await import('typescript')) as unknown as { default?: TypeScriptModule } & TypeScriptModule;
    const ts = loaded.default ?? loaded;
    typescriptModule = locked && ts.version === locked ? ts : null;
  } catch {
    typescriptModule = null;
  }
  return typescriptModule;
}

function scriptKind(ts: TypeScriptModule, path: string) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface ParsedSource {
  readonly printed: string;
  readonly lexemes: readonly string[];
}

function parseForComparison(ts: TypeScriptModule, path: string, text: string): ParsedSource | null {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (!diagnostics || diagnostics.length > 0) return null;
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const lexemes: string[] = [];
  const commentsOf = (from: number, to: number): void => {
    if (to <= from) return;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to));
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia
        || kind === ts.SyntaxKind.ShebangTrivia || kind === ts.SyntaxKind.ConflictMarkerTrivia) {
        lexemes.push(`c:${scanner.getTokenText()}`);
      }
    }
  };
  const visit = (node: import('typescript').Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      lexemes.push(`j:${text.slice(node.pos, node.end)}`);
      return;
    }
    commentsOf(node.pos, node.getStart(sourceFile));
    lexemes.push(`${node.kind}:${node.getText(sourceFile)}`);
  };
  visit(sourceFile);
  return { printed: printer.printFile(sourceFile), lexemes };
}

async function formatterEquivalent(path: string, before: string, after: string): Promise<boolean> {
  if (!SOURCE_EXTENSION.test(path)) return false;
  const ts = await loadTypescript();
  if (!ts) return false;
  const left = parseForComparison(ts, path, before);
  const right = parseForComparison(ts, path, after);
  if (!left || !right || left.printed !== right.printed || left.lexemes.length !== right.lexemes.length) return false;
  return left.lexemes.every((lexeme, index) => lexeme === right.lexemes[index]);
}

// ---------------------------------------------------------------------------
// Runtime: per-commit AC2 accounting
// ---------------------------------------------------------------------------

function parseRawDiff(output: string): Array<{ oldMode: string; newMode: string; oldOid: string; newOid: string; status: string; path: string }> {
  const parts = output.split('\0');
  const entries: Array<{ oldMode: string; newMode: string; oldOid: string; newOid: string; status: string; path: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w+)$/u.exec(parts[index] ?? '');
    if (!meta) continue;
    entries.push({
      oldMode: meta[1]!, newMode: meta[2]!, oldOid: meta[3]!, newOid: meta[4]!, status: meta[5]!, path: parts[index + 1] ?? '',
    });
  }
  return entries;
}

async function typescriptFormatterFailure(cwd: string, parent: string, commit: string): Promise<string | null> {
  const diff = git(cwd, ['diff-tree', '-r', '--raw', '--no-renames', '--no-abbrev', '-z', parent, commit]);
  if (!diff.ok) return 'the commit delta against its parent is unreadable';
  for (const entry of parseRawDiff(diff.stdout)) {
    if (entry.status !== 'M' || entry.oldMode !== entry.newMode
      || (entry.newMode !== '100644' && entry.newMode !== '100755')) {
      return `${entry.path}: added, deleted, renamed, mode-changed or non-regular file`;
    }
    if (!SOURCE_EXTENSION.test(entry.path)) return `${entry.path}: not a .ts/.tsx/.js/.jsx source file`;
    const before = gitBlob(cwd, entry.oldOid);
    const after = gitBlob(cwd, entry.newOid);
    if (before === null || after === null) return `${entry.path}: file bytes are unreadable`;
    if (!(await formatterEquivalent(entry.path, before, after))) {
      return `${entry.path}: change is not proven formatter-only by the pack TypeScript printer/token comparator`;
    }
  }
  return null;
}

function withScratchDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'opk-b5-proof-'));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Positive 2: exact `patch.diff` bytes from a verified same-endpoint fetched ref, applied unchanged to the exact parent tree. */
function publishedPatchFailure(cwd: string, parent: string, commit: string, published: readonly string[]): string | null {
  const wanted = trimmed(git(cwd, ['rev-parse', `${commit}^{tree}`]).stdout);
  const blobs = new Set<string>();
  for (const tip of published.slice(0, MAX_PATCH_SOURCES)) {
    const found = git(cwd, ['rev-parse', '--verify', '--quiet', `${tip}:patch.diff`]);
    const oid = trimmed(found.stdout);
    if (found.ok && OID.test(oid) && trimmed(git(cwd, ['cat-file', '-t', oid]).stdout) === 'blob') blobs.add(oid);
  }
  if (blobs.size === 0) return 'no verified same-endpoint published patch.diff exists';
  return withScratchDir((dir) => {
    let counter = 0;
    for (const blob of blobs) {
      const env = { GIT_INDEX_FILE: join(dir, `index-${counter += 1}`) };
      const bytes = git(cwd, ['cat-file', 'blob', blob], undefined, undefined, 'latin1');
      if (!bytes.ok || !git(cwd, ['read-tree', parent], undefined, env).ok) continue;
      const applied = git(cwd, [...PROOF_GIT, 'apply', '--cached', '--whitespace=nowarn'],
        Buffer.from(bytes.stdout, 'latin1'), env);
      if (applied.ok && trimmed(git(cwd, ['write-tree'], undefined, env).stdout) === wanted) return null;
    }
    return 'the proposed tree is not the exact application of any verified published patch.diff to its parent';
  });
}

const RUFF_LOCK_FILES = ['uv.lock', 'poetry.lock'] as const;
const RUFF_PIN = /\[\[package\]\]\s*\n\s*name\s*=\s*"ruff"\s*\n\s*version\s*=\s*"([^"]+)"/gu;

/** Positive 3: `ruff format` then `ruff check --fix`, version/config taken from the already-published parent. */
function ruffReproductionFailure(cwd: string, parent: string, commit: string, published: readonly string[],
  changedPaths: readonly string[]): string | null {
  if (changedPaths.length === 0 || !changedPaths.every((path) => path.endsWith('.py'))) return 'the commit is not .py-only';
  const parentPublished = published.some((tip) => git(cwd, ['merge-base', '--is-ancestor', parent, tip]).ok);
  if (!parentPublished) return 'parent commit is not proven published on this endpoint';
  let pin: string | null = null;
  for (const lock of RUFF_LOCK_FILES) {
    const text = git(cwd, ['cat-file', 'blob', `${parent}:${lock}`]);
    if (!text.ok) continue;
    const versions = [...text.stdout.matchAll(RUFF_PIN)].map((match) => match[1]!);
    if (versions.length === 1) { pin = versions[0]!; break; }
  }
  if (!pin) return 'parent commit has no single lock-pinned ruff version (uv.lock or poetry.lock)';
  const gitDir = trimmed(git(cwd, ['rev-parse', '--absolute-git-dir']).stdout);
  const wanted = trimmed(git(cwd, ['rev-parse', `${commit}^{tree}`]).stdout);
  return withScratchDir((dir) => {
    const work = join(dir, 'work');
    const home = join(dir, 'home');
    mkdirSync(work, { recursive: true });
    mkdirSync(home, { recursive: true });
    const env = { GIT_INDEX_FILE: join(dir, 'parent-index') };
    if (!git(cwd, ['read-tree', parent], undefined, env).ok
      || !git(cwd, [...PROOF_GIT, 'checkout-index', '-a', '-f', `--prefix=${work}/`], undefined, env).ok) {
      return 'the parent tree cannot be materialized for the isolated Ruff run';
    }
    const tool = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, RUFF_NO_CACHE: 'true' };
    const run = (args: string[]) => runProcessSync({ command: 'ruff', args, cwd: work, env: tool });
    const version = run(['--version']);
    const reported = /^ruff (\S+)/u.exec(trimmed(version.stdout))?.[1];
    if (!version.ok || reported !== pin) {
      return `ruff executable ${reported ?? 'not found'} does not match the parent lock pin ${pin}`;
    }
    if (!run(['format', '--no-cache', '.']).ok) return 'ruff format failed on the parent tree';
    const fixed = run(['check', '--fix', '--no-cache', '.']);
    if (fixed.exitCode === null || fixed.exitCode > 1) return 'ruff check --fix failed on the parent tree';
    const outEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: work, GIT_INDEX_FILE: join(dir, 'result-index') };
    const added = git(work, [...PROOF_GIT, 'add', '-A', '-f', '.'], undefined, outEnv);
    const tree = trimmed(git(work, ['write-tree'], undefined, outEnv).stdout);
    if (!added.ok || tree !== wanted) return 'the proposed tree is not the exact pinned Ruff output on the parent tree';
    return null;
  });
}

async function classifyOrdinaryCommit(cwd: string, parent: string, commit: string,
  published: readonly string[]): Promise<string | null> {
  const typescript = await typescriptFormatterFailure(cwd, parent, commit);
  if (typescript === null) return null;
  const patch = publishedPatchFailure(cwd, parent, commit, published);
  if (patch === null) return null;
  const changed = parseRawDiff(git(cwd, ['diff-tree', '-r', '--raw', '--no-renames', '--no-abbrev', '-z', parent, commit]).stdout)
    .map((entry) => entry.path);
  const ruff = ruffReproductionFailure(cwd, parent, commit, published, changed);
  if (ruff === null) return null;
  return `${typescript}; patch.diff proof: ${patch}; Ruff proof: ${ruff}`;
}

function mergeDriverConfigured(cwd: string): boolean {
  const drivers = git(cwd, ['config', '--get-regexp', '^(merge\\..*\\.(driver|recursive)|filter\\..*\\.(clean|smudge|process))$']);
  return drivers.ok && trimmed(drivers.stdout) !== '';
}

function classifyMergeCommit(cwd: string, commit: string, parents: readonly string[]): string | null {
  if (parents.length !== 2) return 'octopus merge commits are not provable';
  if (mergeDriverConfigured(cwd)) return 'custom merge drivers or content filters are configured; the automatic merge is not provable';
  const merged = git(cwd, ['merge-tree', '--write-tree', '--no-messages', parents[0]!, parents[1]!]);
  if (!merged.ok) return 'the two parents do not merge cleanly (conflict, unrelated history or unprovable result)';
  const automatic = trimmed(merged.stdout.split('\n')[0] ?? '');
  const actual = trimmed(git(cwd, ['rev-parse', `${commit}^{tree}`]).stdout);
  if (!automatic || automatic !== actual) return 'the merge tree differs from the trusted automatic merge (hand resolution or merge-introduced edit)';
  return null;
}

interface AccountingInput {
  readonly cwd: string;
  readonly localOid: string;
  readonly baseOid: string;
  readonly published: readonly string[];
}

async function newCommitFailure(input: AccountingInput): Promise<string | null> {
  const listed = git(input.cwd, ['rev-list', '--parents', '--reverse', '--topo-order', '--stdin'],
    `${[input.localOid, ...[input.baseOid, ...input.published].map((oid) => `^${oid}`)].join('\n')}\n`);
  if (!listed.ok) return 'the outgoing commit range is unreadable';
  const rows = listed.stdout.split('\n').map(trimmed).filter(Boolean).map((line) => line.split(' '));
  if (rows.length > MAX_NEW_COMMITS) return `${rows.length} unpublished commits exceed the provable limit of ${MAX_NEW_COMMITS}`;
  for (const [commit, ...parents] of rows) {
    if (!commit) continue;
    const short = commit.slice(0, 12);
    let failure: string | null;
    if (parents.length === 0) failure = 'root commit has no parent to compare';
    else if (parents.length === 1) failure = await classifyOrdinaryCommit(input.cwd, parents[0]!, commit, input.published);
    else failure = classifyMergeCommit(input.cwd, commit, parents);
    if (failure) return `unpublished manager-local commit ${short}: ${failure}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime: pre-push evaluation
// ---------------------------------------------------------------------------

type DenialClass = 'AC2' | 'AC3' | 'AC4';

interface Denial {
  readonly cls: DenialClass;
  readonly ref: string;
  readonly reason: string;
  readonly nextStep: string;
}

const AC2_NEXT = 'send the hand fix to GPT as author; fetch its published same-endpoint scratch patch.diff and apply it verbatim (exact tree proof), or reproduce the parent lock-pinned Python Ruff output (ruff format, then ruff check --fix) on an already-published parent, or publish through an authorized non-manager GPT/worker Issue/PR route (for a conflict ask GPT for a published two-parent merge, else report to the orchestrator for the merge agent); never push the same unproved substantive commit again from this manager worktree';

interface Tuple {
  readonly localRef: string;
  readonly localOid: string;
  readonly remoteRef: string;
  readonly remoteOid: string;
}

function parseTuples(stdin: string): Tuple[] {
  return stdin.split('\n').map(trimmed).filter(Boolean).flatMap((line) => {
    const [localRef, localOid, remoteRef, remoteOid] = line.split(/\s+/u);
    return localRef && localOid && remoteRef && remoteOid ? [{ localRef, localOid, remoteRef, remoteOid }] : [];
  });
}

function objectType(cwd: string, oid: string): string {
  return trimmed(git(cwd, ['cat-file', '-t', oid]).stdout);
}

async function evaluateTuples(cwd: string, endpointUrl: string, stdin: string): Promise<Denial[]> {
  const endpoint = normalizeEndpoint(endpointUrl, cwd);
  const defaultBranch = worktreeConfig(cwd, KEY.defaultBranch);
  const remotes = verifiedFetchRemotes(cwd, endpoint);
  const published = publishedCommitOids(cwd, remotes);
  const seedOid = worktreeConfig(cwd, KEY.seedOid);
  const seedEndpoint = worktreeConfig(cwd, KEY.seedEndpoint);
  const denials: Denial[] = [];
  for (const tuple of parseTuples(stdin)) {
    const deleting = ZERO_OID.test(tuple.localOid);
    const creating = ZERO_OID.test(tuple.remoteOid);
    if (!defaultBranch || tuple.remoteRef === `refs/heads/${defaultBranch}`) {
      denials.push({
        cls: 'AC3', ref: tuple.remoteRef,
        reason: defaultBranch
          ? `${deleting ? 'deleting' : 'updating'} the selected default branch ${defaultBranch} from a manager worktree`
          : 'the selected default branch is not recorded for this manager worktree',
        nextStep: defaultBranch
          ? 'send the change to GPT as author through a nondefault branch and PR; never push the default branch from a manager worktree'
          : 'reinstall the manager push guard through the supervised launch so the selected default branch is recorded',
      });
      continue;
    }
    if (!creating) {
      const tracking = resolveTrackingRef(cwd, remotes, tuple.remoteRef);
      const fetchStep = `fetch ${endpointUrl} (the actual push endpoint) into its matching tracking ref, integrate ${tuple.remoteRef} without destructive history rewrite (merge, never rebase or reset a shared ref), then push again`;
      if (tracking.kind === 'unverified') {
        denials.push({
          cls: 'AC4', ref: tuple.remoteRef, reason: `freshness unverified: ${tracking.reason}`,
          nextStep: `${fetchStep}; configure a remote whose fetch URL is ${endpointUrl} with a positive fetch refspec if none maps it`,
        });
        continue;
      }
      const trackingOid = trimmed(git(cwd, ['rev-parse', '--verify', '--quiet', tracking.tracking]).stdout);
      if (!OID.test(trackingOid) || trackingOid !== tuple.remoteOid) {
        denials.push({
          cls: 'AC4', ref: tuple.remoteRef,
          reason: `advertised ${tuple.remoteOid.slice(0, 12)} differs from fetched ${tracking.tracking} (${trackingOid ? trackingOid.slice(0, 12) : 'absent'})`,
          nextStep: fetchStep,
        });
        continue;
      }
      if (!deleting) {
        const remoteIsCommit = objectType(cwd, tuple.remoteOid) === 'commit';
        const localIsCommit = objectType(cwd, tuple.localOid) === 'commit';
        const contained = remoteIsCommit && localIsCommit
          && git(cwd, ['merge-base', '--is-ancestor', tuple.remoteOid, tuple.localOid]).ok;
        if (!contained) {
          denials.push({
            cls: 'AC4', ref: tuple.remoteRef,
            reason: remoteIsCommit && localIsCommit
              ? `advertised tip ${tuple.remoteOid.slice(0, 12)} is not contained in the proposed update`
              : 'the existing or proposed object is not a commit, so no ref-state baseline is provable',
            nextStep: tuple.remoteRef.startsWith('refs/heads/') ? fetchStep
              : `${tuple.remoteRef} is not a branch: fetch it from the push endpoint, then recreate or reconcile it instead of rebasing`,
          });
          continue;
        }
      }
    }
    if (deleting) continue;
    if (objectType(cwd, tuple.localOid) !== 'commit') {
      denials.push({
        cls: 'AC2', ref: tuple.remoteRef,
        reason: 'the published object is not a plain commit (annotated tag or other object) with provable content', nextStep: AC2_NEXT,
      });
      continue;
    }
    let baseOid = tuple.remoteOid;
    if (creating) {
      const seedUsable = seedOid !== null && OID.test(seedOid) && seedEndpoint !== null
        && normalizeEndpoint(seedEndpoint, cwd) === endpoint
        && objectType(cwd, seedOid) === 'commit'
        && git(cwd, ['merge-base', '--is-ancestor', seedOid, tuple.localOid]).ok;
      if (!seedUsable) {
        denials.push({
          cls: 'AC2', ref: tuple.remoteRef,
          reason: 'new remote ref with no verified same-endpoint placement seed ancestral to the proposed update; unpublished content is unprovable',
          nextStep: `${AC2_NEXT}; or re-establish a known-clean manager placement from the selected default or a published PR head`,
        });
        continue;
      }
      baseOid = seedOid;
    }
    const failure = await newCommitFailure({ cwd, localOid: tuple.localOid, baseOid, published });
    if (failure) denials.push({ cls: 'AC2', ref: tuple.remoteRef, reason: failure, nextStep: AC2_NEXT });
  }
  return denials;
}

function delegateOriginalHook(args: readonly string[], stdin: Buffer): number {
  const original = process.env[ORIGINAL_HOOK_ENV];
  if (!original) return 0;
  const { [ORIGINAL_HOOK_ENV]: _own, ...env } = process.env;
  const result = runProcessSync({
    command: original, args, input: stdin, env, forwardOutputToStderr: true,
  });
  if (result.error) {
    process.stderr.write(`[manager-push-guard] inherited pre-push hook could not run: ${result.error}\n`);
    return 1;
  }
  if (result.exitCode !== null) return result.exitCode;
  return 128 + (result.signal ? (osConstants.signals[result.signal] ?? 1) : 1);
}

export async function runPrePush(args: readonly string[], stdin: Buffer, cwd: string): Promise<number> {
  const endpointUrl = args[1] ?? '';
  const denials = await evaluateTuples(cwd, endpointUrl, stdin.toString('utf8'));
  if (denials.length > 0) {
    for (const denial of denials) {
      process.stderr.write(`[manager-push-guard] ${denial.cls} denied ${denial.ref} -> ${endpointUrl}: ${denial.reason}\n`
        + `  next: ${denial.nextStep}\n`);
    }
    process.stderr.write(`[manager-push-guard] push to ${endpointUrl} aborted for every ref update of this invocation (${denials.map((d) => d.cls).join(', ')}).\n`);
    return 1;
  }
  return delegateOriginalHook(args, stdin);
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

export interface ManagerPushGuardInstallRequest {
  readonly worktreePath: string;
  readonly defaultBranch: string;
  /** True when an effective URL is the same repository as the selected project. */
  readonly endpointMatchesRepository: (url: string) => boolean;
  /** Verified clean same-invocation placement tip; absent on reuse/provider placement. */
  readonly placementSeedOid?: string;
}

export type ManagerPushGuardInstallResult =
  | { readonly ok: true; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly cause: string; readonly note: string; readonly evidence: Readonly<Record<string, unknown>> };

function refuse(cause: string, note: string, evidence: Readonly<Record<string, unknown>> = {}): ManagerPushGuardInstallResult {
  return { ok: false, cause, note, evidence };
}

function stubHeader(name: string): string {
  return `#!/bin/sh
# Generated by manager-push-guard (Issue #2732): ${name}. Delegates the originally effective hook.
own_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
orig=$(git config --worktree --get ${KEY.originalHooksPath} 2>/dev/null)
if [ -z "$orig" ]; then orig="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"; fi
case "$orig" in /*) ;; *) orig="$PWD/$orig" ;; esac
orig_dir=$(CDPATH= cd -- "$orig" 2>/dev/null && pwd -P) || orig_dir=
if [ "$orig_dir" = "$own_dir" ]; then
  echo "manager-push-guard: original hooks path resolves to the guard hooks directory (self-chain); reinstall through the supervised launch" >&2
  exit 1
fi
hook="$orig_dir/${name}"
`;
}

function delegateStub(name: string): string {
  return `${stubHeader(name)}if [ -z "$orig_dir" ] || [ ! -f "$hook" ] || [ ! -x "$hook" ]; then exit 0; fi
exec "$hook" "$@"
`;
}

function prePushStub(): string {
  const entry = fileURLToPath(import.meta.url);
  return `${stubHeader('pre-push')}if [ -z "$orig_dir" ] || [ ! -f "$hook" ] || [ ! -x "$hook" ]; then hook=; fi
export ${ORIGINAL_HOOK_ENV}="$hook"
exec ${shellQuote(process.execPath)} --no-warnings --experimental-strip-types ${shellQuote(entry)} pre-push "$@"
`;
}

function worktreeRoots(cwd: string): string[] | null {
  const listed = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;
  return listed.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length).trim());
}

function effectiveHooksDir(root: string): string | null {
  const resolved = git(root, ['rev-parse', '--git-path', 'hooks']);
  if (!resolved.ok) return null;
  const path = trimmed(resolved.stdout);
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function snapshotHooks(roots: readonly string[]): Map<string, string | null> {
  return new Map(roots.map((root) => [safeReal(root), effectiveHooksDir(root)]));
}

function safeReal(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function installManagerPushGuard(request: ManagerPushGuardInstallRequest): ManagerPushGuardInstallResult {
  const worktree = safeReal(request.worktreePath);
  const evidence: Record<string, unknown> = { worktreePath: worktree };
  const defaultBranch = trimmed(request.defaultBranch);
  if (!defaultBranch) {
    return refuse('manager_push_guard_default_branch_unresolved',
      'resolve the selected project default branch, then rerun the supervised manager launch', evidence);
  }
  const top = git(worktree, ['rev-parse', '--show-toplevel']);
  const adminDir = git(worktree, ['rev-parse', '--absolute-git-dir']);
  const commonDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!top.ok || safeReal(trimmed(top.stdout)) !== worktree || !adminDir.ok || !commonDir.ok) {
    return refuse('manager_push_guard_worktree_unobserved',
      'prove the exact manager worktree path with git rev-parse before installing the push guard', evidence);
  }
  const admin = safeReal(trimmed(adminDir.stdout));
  const common = safeReal(trimmed(commonDir.stdout));
  if (admin === common) {
    return refuse('manager_push_guard_not_linked_worktree',
      'the push guard is installed only in a linked manager worktree, never the primary checkout', evidence);
  }
  const commonConfig = join(common, 'config');
  const commonBare = git(worktree, ['config', '--file', commonConfig, '--get', 'core.bare']);
  const commonWorktree = git(worktree, ['config', '--file', commonConfig, '--get', 'core.worktree']);
  if ((commonBare.ok && trimmed(commonBare.stdout) === 'true') || commonWorktree.ok) {
    return refuse('manager_push_guard_shared_config_unsafe',
      'the common repository config sets core.bare or core.worktree, so per-worktree config cannot be enabled safely; move those keys into the owning worktree config (git worktree docs, "Configuration file"), then rerun the supervised launch', evidence);
  }
  const roots = worktreeRoots(worktree);
  if (!roots || roots.length === 0) {
    return refuse('manager_push_guard_worktrees_unobserved',
      'git worktree list failed; repair the repository registry before installing the push guard', evidence);
  }
  const before = snapshotHooks(roots);
  const extension = git(worktree, ['config', '--file', commonConfig, '--get', 'extensions.worktreeConfig']);
  const extensionWasOn = extension.ok && trimmed(extension.stdout) === 'true';
  if (!extensionWasOn) {
    if (!git(worktree, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true']).ok) {
      return refuse('manager_push_guard_worktree_config_unavailable',
        'enable extensions.worktreeConfig manually (git config extensions.worktreeConfig true) after checking tooling compatibility, then rerun the supervised launch', evidence);
    }
  }
  const rollbackExtension = (): void => {
    if (!extensionWasOn) git(worktree, ['config', '--file', commonConfig, '--unset', 'extensions.worktreeConfig']);
  };
  const opens = roots.every((root) => git(root, ['rev-parse', '--show-toplevel']).ok && git(root, ['rev-parse', '--git-dir']).ok);
  if (!opens) {
    rollbackExtension();
    return refuse('manager_push_guard_tooling_incompatible',
      'a registered worktree no longer opens after enabling per-worktree config; the change was reverted. Repair or prune the broken worktree, then rerun the supervised launch', evidence);
  }

  const marked = worktreeConfig(worktree, KEY.installed) === 'true';
  const hooksDir = join(admin, GUARD_DIR_NAME, 'hooks');
  const ownReal = (): string => { try { return realpathSync(hooksDir); } catch { return hooksDir; } };
  const currentHooksPath = git(worktree, ['config', '--type=path', '--get', 'core.hooksPath']);
  const currentValue = currentHooksPath.ok ? trimmed(currentHooksPath.stdout) : null;
  const currentIsOwn = currentValue !== null
    && safeReal(isAbsolute(currentValue) ? currentValue : resolve(worktree, currentValue)) === ownReal();
  if (!marked || (currentValue !== null && !currentIsOwn)) {
    if (currentValue !== null && currentIsOwn) {
      rollbackExtension();
      return refuse('manager_push_guard_self_chain',
        'core.hooksPath already selects the guard directory without a recorded original; restore the original core.hooksPath and rerun the supervised launch', evidence);
    }
    if (currentValue === null) git(worktree, ['config', '--worktree', '--unset', KEY.originalHooksPath]);
    else if (!git(worktree, ['config', '--worktree', KEY.originalHooksPath,
      isAbsolute(currentValue) ? currentValue : resolve(worktree, currentValue)]).ok) {
      rollbackExtension();
      return refuse('manager_push_guard_config_write_failed', 'repair the manager worktree config file, then rerun the supervised launch', evidence);
    }
  }
  const recordedOriginal = worktreeConfig(worktree, KEY.originalHooksPath);
  const originalDir = recordedOriginal === null
    ? join(common, 'hooks')
    : isAbsolute(recordedOriginal) ? recordedOriginal : resolve(worktree, recordedOriginal);
  if (safeReal(originalDir) === ownReal()) {
    rollbackExtension();
    return refuse('manager_push_guard_self_chain',
      'the original hooks path resolves to the guard hooks directory; restore the original core.hooksPath and rerun the supervised launch', evidence);
  }

  try {
    mkdirSync(hooksDir, { recursive: true });
    const names = new Set<string>(DELEGATED_HOOKS);
    const originalReal = safeReal(originalDir);
    if (existsSync(originalReal)) {
      for (const name of readdirSync(originalReal)) {
        if (/^[a-z][a-z0-9-]*$/u.test(name)) names.add(name);
      }
    }
    for (const name of names) {
      const path = join(hooksDir, name);
      writeFileSync(path, name === 'pre-push' ? prePushStub() : delegateStub(name), { mode: 0o755 });
      chmodSync(path, 0o755);
    }
  } catch (error) {
    rollbackExtension();
    return refuse('manager_push_guard_hooks_unwritable',
      `repair write access to ${hooksDir}, then rerun the supervised launch (${error instanceof Error ? error.message : String(error)})`, evidence);
  }

  const writes: Array<[string, string]> = [
    ['core.hooksPath', hooksDir], [KEY.installed, 'true'], [KEY.defaultBranch, defaultBranch],
  ];
  if (worktreeConfig(worktree, KEY.seedOid) === null && request.placementSeedOid && OID.test(request.placementSeedOid)) {
    const fetchUrl = git(worktree, ['remote', 'get-url', 'origin']);
    const pushUrl = git(worktree, ['remote', 'get-url', '--push', 'origin']);
    const fetchEndpoint = fetchUrl.ok ? normalizeEndpoint(trimmed(fetchUrl.stdout), worktree) : '';
    const pushEndpoint = pushUrl.ok ? normalizeEndpoint(trimmed(pushUrl.stdout), worktree) : '';
    if (fetchEndpoint && fetchEndpoint === pushEndpoint
      && request.endpointMatchesRepository(trimmed(fetchUrl.stdout)) && request.endpointMatchesRepository(trimmed(pushUrl.stdout))
      && objectType(worktree, request.placementSeedOid) === 'commit') {
      writes.push([KEY.seedOid, request.placementSeedOid], [KEY.seedEndpoint, pushEndpoint]);
      evidence.seed = 'recorded';
    } else {
      evidence.seed = 'endpoint_unverified';
    }
  }
  for (const [key, value] of writes) {
    if (!git(worktree, ['config', '--worktree', key, value]).ok) {
      rollbackExtension();
      return refuse('manager_push_guard_config_write_failed', 'repair the manager worktree config file, then rerun the supervised launch', evidence);
    }
  }

  // Observe the effective result; never claim protection from a file's presence alone.
  const origin = git(worktree, ['config', '--worktree', '--show-origin', '--get', 'core.hooksPath']);
  const observed = effectiveHooksDir(worktree);
  const prePush = join(hooksDir, 'pre-push');
  const probe = runProcessSync({
    command: process.execPath, inheritParentEnv: true,
    args: ['--no-warnings', '--experimental-strip-types', fileURLToPath(import.meta.url), 'probe'],
  });
  const after = snapshotHooks(roots);
  const othersUnchanged = [...before].every(([root, hooks]) => root === worktree || after.get(root) === hooks);
  const effective = origin.ok && origin.stdout.includes('config.worktree') && observed === ownReal()
    && existsSync(prePush)
    && trimmed(probe.stdout) === 'manager-push-guard-ok' && othersUnchanged;
  if (!effective) {
    git(worktree, ['config', '--worktree', '--unset', 'core.hooksPath']);
    git(worktree, ['config', '--worktree', '--unset', KEY.installed]);
    return refuse('manager_push_guard_unobserved',
      'the guard hook is not effective for this manager only (hooksPath not selected from config.worktree, probe failed, or another worktree changed); the selection was reverted. Fix the worktree config or Node runtime and rerun the supervised launch; do not rely on push protection until it is observed',
      { ...evidence, effectiveHooksDir: observed, othersUnchanged });
  }
  return { ok: true, evidence: { ...evidence, hooksDir: ownReal(), reinstall: marked, extensionEnabledHere: !extensionWasOn } };
}

// ---------------------------------------------------------------------------
// CLI (invoked only by the generated pre-push stub)
// ---------------------------------------------------------------------------

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

if (process.argv[1]?.endsWith('manager-push-guard.ts')) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'probe') {
    process.stdout.write('manager-push-guard-ok\n');
  } else if (command === 'pre-push') {
    process.exitCode = await runPrePush(args, await readStdin(), process.cwd());
  } else {
    process.stderr.write('usage: manager-push-guard.ts pre-push <remote> <url> | probe\n');
    process.exitCode = 2;
  }
}
