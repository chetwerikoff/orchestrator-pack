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
 * original hook. This module owns exactly two push denials:
 *   AC3 - any update/delete of the selected project's default branch,
 *   AC4 - an existing destination whose advertised OID lacks a verified fetched
 *         baseline for the same push endpoint, differs from it, or is not an
 *         ancestor of the proposed update.
 * Content and path scope remain the responsibility of downstream PR CI/review,
 * not this local pre-push guard.
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
  boundEndpoint: `${CONFIG_SECTION}.boundEndpoint`,
} as const;
const GUARD_DIR_NAME = 'opk-manager-push-guard';
const ORIGINAL_HOOK_ENV = 'OPK_B5_ORIGINAL_HOOK';
const ZERO_OID = /^0+$/u;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
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
  readonly timedOut: boolean;
  readonly outcome: string;
}

function git(cwd: string, args: readonly string[], input?: string | Uint8Array, env?: Readonly<NodeJS.ProcessEnv>,
  encoding?: BufferEncoding, timeoutMs?: number): GitResult {
  const result = runProcessSync({
    command: 'git', args, cwd, ...(input === undefined ? {} : { input }), ...(encoding ? { encoding } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, inheritParentEnv: true,
  });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, outcome: result.outcome };
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

/** Display-only endpoint: strips userinfo, query and fragment so a refusal never prints a credential. */
export function redactEndpoint(url: string): string {
  const value = trimmed(url);
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@?#]*@)?([^/?#]*)([^?#]*)/iu.exec(value);
  if (match) return `${match[1]}${match[2]}${match[3]}`;
  return value.replace(/[?#].*$/u, '').replace(/^[^/@\s]+@(?=[^/\s]+:)/u, '');
}

// ---------------------------------------------------------------------------
// Runtime: endpoint-to-tracking-ref resolution
// ---------------------------------------------------------------------------

interface Refspec {
  readonly negative: boolean;
  readonly src: string;
  readonly dst: string;
}

function parseRefspecText(text: string): Refspec[] {
  const specs: Refspec[] = [];
  for (const raw of text.split('\n').map(trimmed).filter(Boolean)) {
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

function parseRefspecs(cwd: string, remote: string): Refspec[] {
  const listed = git(cwd, ['config', '--get-all', `remote.${remote}.fetch`]);
  return listed.ok ? parseRefspecText(listed.stdout) : [];
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

/** Locally authored namespaces: a fetch destination there is not independent evidence of publication. */
function aliasesLocalRefs(dst: string): boolean {
  const star = dst.indexOf('*');
  const prefix = star < 0 ? dst : dst.slice(0, star);
  return ['refs/heads/', 'refs/tags/'].some((ns) => ns.startsWith(prefix) || prefix.startsWith(ns));
}

/**
 * Remotes whose effective fetch URL is exactly the actual push endpoint. Tracking refs are inherited from the endpoint
 * the manager was installed against: a repointed origin never relabels them as published on the new endpoint.
 */
function verifiedFetchRemotes(cwd: string, pushEndpoint: string): string[] {
  for (const key of [KEY.boundEndpoint, KEY.seedEndpoint]) {
    const recorded = worktreeConfig(cwd, key);
    if (recorded !== null && normalizeEndpoint(recorded, cwd) !== pushEndpoint) return [];
  }
  const names = git(cwd, ['remote']);
  if (!names.ok) return [];
  const verified: string[] = [];
  for (const name of names.stdout.split('\n').map(trimmed).filter(Boolean)) {
    // Git fetches only from the first configured URL; later `url` entries never supply tracking refs.
    const fetchUrl = git(cwd, ['remote', 'get-url', name]);
    if (fetchUrl.ok && normalizeEndpoint(trimmed(fetchUrl.stdout), cwd) === pushEndpoint) verified.push(name);
  }
  return verified;
}

type TrackingResolution =
  | { readonly kind: 'ok'; readonly tracking: string }
  | { readonly kind: 'unverified'; readonly reason: string };

function resolveTrackingRef(cwd: string, remotes: readonly string[], remoteRef: string): TrackingResolution;
function resolveTrackingRef(cwd: string, remotes: readonly string[], remoteRef: string,
  cached: ReadonlyMap<string, readonly Refspec[]>, hasTime: () => boolean): TrackingResolution | null;
function resolveTrackingRef(cwd: string, remotes: readonly string[], remoteRef: string,
  cached?: ReadonlyMap<string, readonly Refspec[]>, hasTime?: () => boolean): TrackingResolution | null {
  if (remotes.length === 0) {
    return { kind: 'unverified', reason: 'no configured remote has an effective fetch URL equal to this push endpoint' };
  }
  const candidates = new Set<string>();
  for (const remote of remotes) {
    if (hasTime && !hasTime()) return null;
    const specs = cached?.get(remote) ?? parseRefspecs(cwd, remote);
    for (const spec of specs) {
      if (hasTime && !hasTime()) return null;
      if (spec.negative && negativeMatches(spec, remoteRef)) {
        return { kind: 'unverified', reason: `a negative fetch refspec of remote ${remote} excludes ${remoteRef}` };
      }
    }
    for (const spec of specs) {
      if (hasTime && !hasTime()) return null;
      if (spec.negative) continue;
      const mapped = mapThroughRefspec(spec, remoteRef);
      if (mapped && !aliasesLocalRefs(mapped)) candidates.add(mapped);
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

// Runtime: pre-push evaluation
// ---------------------------------------------------------------------------

type DenialClass = 'AC3' | 'AC4';

interface Denial {
  readonly cls: DenialClass;
  readonly ref: string;
  readonly reason: string;
  readonly nextStep: string;
}

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

function evaluateTuples(cwd: string, endpointUrl: string, stdin: string): Denial[] {
  const endpoint = normalizeEndpoint(endpointUrl, cwd);
  const shownEndpoint = redactEndpoint(endpointUrl);
  const defaultBranch = worktreeConfig(cwd, KEY.defaultBranch);
  const remotes = verifiedFetchRemotes(cwd, endpoint);
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
      const fetchStep = `fetch ${shownEndpoint} (the actual push endpoint) into its matching tracking ref, integrate ${tuple.remoteRef} without destructive history rewrite (merge, never rebase or reset a shared ref), then push again`;
      if (tracking.kind === 'unverified') {
        denials.push({
          cls: 'AC4', ref: tuple.remoteRef, reason: `freshness unverified: ${tracking.reason}`,
          nextStep: `${fetchStep}; configure a remote whose fetch URL is ${shownEndpoint} with a positive fetch refspec if none maps it`,
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
  }
  return denials;
}

function delegateOriginalHook(args: readonly string[], stdin: Buffer): number {
  const original = process.env[ORIGINAL_HOOK_ENV];
  if (!original) return 0;
  const { [ORIGINAL_HOOK_ENV]: _own, ...env } = process.env;
  // Feed the ref tuples from a file: a pipe write to a hook that never reads stdin races into EPIPE and drops its exit status.
  const feed = mkdtempSync(join(tmpdir(), 'opk-b5-stdin-'));
  const tupleFile = join(feed, 'tuples');
  writeFileSync(tupleFile, stdin);
  const result = runProcessSync({
    command: '/bin/sh', args: ['-c', 'exec "$0" "$@" < "$OPK_B5_TUPLES"', original, ...args],
    env: { ...env, OPK_B5_TUPLES: tupleFile },
  });
  rmSync(feed, { recursive: true, force: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    process.stderr.write(`[manager-push-guard] inherited pre-push hook could not run: ${result.error}\n`);
    return 1;
  }
  if (result.exitCode !== null) return result.exitCode;
  return 128 + (result.signal ? (osConstants.signals[result.signal] ?? 1) : 1);
}

export async function runPrePush(args: readonly string[], stdin: Buffer, cwd: string): Promise<number> {
  const endpointUrl = args[1] ?? '';
  const shown = redactEndpoint(endpointUrl);
  const denials = await evaluateTuples(cwd, endpointUrl, stdin.toString('utf8'));
  if (denials.length > 0) {
    process.stderr.write('[manager-push-guard] push to ' + shown
      + ' aborted for every ref update of this invocation (' + denials.map((d) => d.cls).join(', ') + ').\n');
    for (const denial of denials) {
      process.stderr.write('[manager-push-guard] ' + denial.cls + ' denied ' + denial.ref + ' -> '
        + shown + ': ' + denial.reason + '\n  next: ' + denial.nextStep + '\n');
    }
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
  /** Optional synchronous test-only observation at the exact pre-effect sibling snapshot. */
  readonly afterSiblingSnapshot?: () => void;
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

/** Existing per-worktree config files (main and linked) that set anything: enabling the extension would activate every entry. */
function dormantWorktreeConfigFiles(common: string): string[] {
  const files = [join(common, 'config.worktree')];
  try {
    for (const entry of readdirSync(join(common, 'worktrees'))) files.push(join(common, 'worktrees', entry, 'config.worktree'));
  } catch { /* no linked worktree registry */ }
  return files.filter((file) => existsSync(file) && trimmed(git(common, ['config', '--file', file, '--list']).stdout) !== '');
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
  // A deterministic fixture can synchronize two worktrees after both have
  // observed their pre-effect sibling snapshots. Production leaves this unset.
  request.afterSiblingSnapshot?.();
  const extension = git(worktree, ['config', '--file', commonConfig, '--get', 'extensions.worktreeConfig']);
  const extensionWasOn = extension.ok && trimmed(extension.stdout) === 'true';
  if (!extensionWasOn) {
    // Git ignores config.worktree until the extension is on; enabling it would silently activate any dormant setting
    // there and change which hooks the manager or a sibling runs, or where it pushes.
    const dormant = dormantWorktreeConfigFiles(common);
    // A sibling installer can enable the shared extension between our first
    // read and its worktree-local config write. Re-read that native setting:
    // a now-enabled extension means those entries are active, not dormant.
    const enabledBySibling = trimmed(git(worktree, ['config', '--file', commonConfig,
      '--get', 'extensions.worktreeConfig']).stdout) === 'true';
    if (dormant.length > 0 && !enabledBySibling) {
      return refuse('manager_push_guard_dormant_worktree_config',
        `config.worktree already holds settings (hooks, push URL or others) in ${dormant.join(', ')} while extensions.worktreeConfig is off; enabling per-worktree config would activate them and change what the manager or a sibling runs or pushes to. Move those settings into the shared config or remove them, then rerun the supervised launch`,
        { ...evidence, dormant });
    }
    if (!enabledBySibling && !git(worktree, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true']).ok) {
      return refuse('manager_push_guard_worktree_config_unavailable',
        'enable extensions.worktreeConfig manually (git config extensions.worktreeConfig true) after checking tooling compatibility, then rerun the supervised launch', evidence);
    }
  }
  // Every config key this install may write, as it stood before: a failed install restores them exactly (never a blind unset).
  const priorConfig = new Map<string, string | null>(
    ['core.hooksPath', ...Object.values(KEY)].map((key) => [key, worktreeConfig(worktree, key)]));
  const rollbackExtension = (): void => {
    for (const [key, value] of priorConfig) {
      if (worktreeConfig(worktree, key) === value) continue;
      if (value === null) git(worktree, ['config', '--worktree', '--unset', key]);
      else git(worktree, ['config', '--worktree', key, value]);
    }
    // Another linked worktree may have installed its own guard while this install ran.
    // Never disable the shared extension while any worktree still selects worktree-local hooks.
    const anyActiveLocalHooks = roots.some((root) => worktreeConfig(root, 'core.hooksPath') !== null);
    // A sibling may be writing its config before its final hooksPath selection.
    // Never disable the extension beneath such an in-flight sibling install.
    const anySiblingWorktreeConfig = dormantWorktreeConfigFiles(common)
      .some((file) => file !== join(admin, 'config.worktree'));
    if (!extensionWasOn && !anyActiveLocalHooks && !anySiblingWorktreeConfig) {
      git(worktree, ['config', '--file', commonConfig, '--unset', 'extensions.worktreeConfig']);
    }
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

  const recordedDefault = worktreeConfig(worktree, KEY.defaultBranch);
  if (recordedDefault !== null && recordedDefault !== defaultBranch) {
    rollbackExtension();
    return refuse('manager_push_guard_default_branch_changed',
      `this manager worktree is bound to default branch ${recordedDefault}, not ${defaultBranch}; do not rebind it silently. Recreate the manager worktree for the selected project, then rerun the supervised launch`, evidence);
  }
  // Never expose an effective sibling hook until the complete local guard
  // metadata and the generated hook are in place. Another manager observing
  // its sibling's changed hooksPath can then prove it is the sibling's own B5.
  const writes: Array<[string, string]> = [
    [KEY.installed, 'true'], [KEY.defaultBranch, defaultBranch],
  ];
  const fetchUrl = git(worktree, ['remote', 'get-url', 'origin']);
  const pushUrl = git(worktree, ['remote', 'get-url', '--push', 'origin']);
  const fetchEndpoint = fetchUrl.ok ? normalizeEndpoint(trimmed(fetchUrl.stdout), worktree) : '';
  const pushEndpoint = pushUrl.ok ? normalizeEndpoint(trimmed(pushUrl.stdout), worktree) : '';
  // Tracking refs are fetched from the endpoint present at first install; a later repoint must not relabel them.
  const recordedBound = worktreeConfig(worktree, KEY.boundEndpoint);
  if (recordedBound !== null && recordedBound !== fetchEndpoint) {
    rollbackExtension();
    return refuse('manager_push_guard_endpoint_changed',
      'origin now resolves to a different endpoint than the one this manager worktree was installed against, so its fetched tracking refs cannot be trusted. Recreate the manager worktree for the selected project (or restore the original origin URL), then rerun the supervised launch', evidence);
  }
  if (recordedBound === null && fetchEndpoint && fetchEndpoint === pushEndpoint) writes.push([KEY.boundEndpoint, fetchEndpoint]);
  if (worktreeConfig(worktree, KEY.seedOid) === null && request.placementSeedOid && OID.test(request.placementSeedOid)) {
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
  if (!git(worktree, ['config', '--worktree', 'core.hooksPath', hooksDir]).ok) {
    rollbackExtension();
    return refuse('manager_push_guard_config_write_failed',
      'repair worktree-local core.hooksPath before activating the manager guard, then retry launch', evidence);
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
  const siblingOwnGuard = (root: string): boolean => {
    const adminResult = git(root, ['rev-parse', '--absolute-git-dir']);
    if (!adminResult.ok || worktreeConfig(root, KEY.installed) !== 'true') return false;
    const siblingHooks = safeReal(join(trimmed(adminResult.stdout), GUARD_DIR_NAME, 'hooks'));
    return after.get(root) === siblingHooks && effectiveHooksDir(root) === siblingHooks;
  };
  const othersUnchanged = [...before].every(([root, hooks]) =>
    root === worktree || after.get(root) === hooks || siblingOwnGuard(root));
  const effective = origin.ok && origin.stdout.includes('config.worktree') && observed === ownReal()
    && existsSync(prePush)
    && trimmed(probe.stdout) === 'manager-push-guard-ok' && othersUnchanged;
  if (!effective) {
    rollbackExtension();
    return refuse('manager_push_guard_unobserved',
      'the guard hook is not effective for this manager only (hooksPath not selected from config.worktree, probe failed, or another worktree changed); the previous worktree config was restored. Fix the worktree config or Node runtime and rerun the supervised launch; do not rely on push protection until it is observed',
      { ...evidence, effectiveHooksDir: observed, othersUnchanged });
  }
  return { ok: true, evidence: { ...evidence, hooksDir: ownReal(), reinstall: marked, extensionEnabledHere: !extensionWasOn } };
}

// ---------------------------------------------------------------------------
// CLI (invoked only by the generated pre-push stub)

/**
 * Claude-family manager handoff: remove only this worktree's previously installed
 * B5 binding and restore the recorded originally effective hook. Never change
 * shared per-worktree configuration or another linked worktree's hooks.
 */
export function restoreManagerPushGuardForClaude(worktreePath: string): ManagerPushGuardInstallResult {
  const worktree = safeReal(worktreePath);
  const evidence = { worktreePath: worktree };
  const top = git(worktree, ['rev-parse', '--show-toplevel']);
  const adminDir = git(worktree, ['rev-parse', '--absolute-git-dir']);
  const commonDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!top.ok || safeReal(trimmed(top.stdout)) !== worktree || !adminDir.ok || !commonDir.ok) {
    return refuse('manager_push_guard_local_route_unobserved',
      'inspect the exact linked worktree and its Git admin/config paths before retrying the Claude-family manager launch', evidence);
  }
  const admin = safeReal(trimmed(adminDir.stdout));
  const common = safeReal(trimmed(commonDir.stdout));
  const hooksDir = safeReal(join(admin, GUARD_DIR_NAME, 'hooks'));
  const effective = effectiveHooksDir(worktree);
  const selectedOwnGuard = effective === hooksDir;
  const installed = worktreeConfig(worktree, KEY.installed);
  const keys = Object.values(KEY).filter((key) => worktreeConfig(worktree, key) !== null);
  if (installed !== 'true') {
    if (selectedOwnGuard || keys.length) {
      return refuse('manager_push_guard_local_route_ambiguous',
        'a guard path or partial guard keys remain without verified installation; inspect config.worktree and restore the original hooks manually before retrying', evidence);
    }
    return { ok: true, evidence: { ...evidence, guard: 'absent' } };
  }
  if (!selectedOwnGuard) {
    return refuse('manager_push_guard_local_route_ambiguous',
      'recorded B5 guard is not the effective hook for this worktree; inspect core.hooksPath and originalHooksPath before retrying', evidence);
  }
  const original = worktreeConfig(worktree, KEY.originalHooksPath);
  if (original !== null && (!isAbsolute(original) || safeReal(original) === hooksDir)) {
    return refuse('manager_push_guard_original_hooks_ambiguous',
      'the recorded original hooks path is relative or points to the guard itself; restore the exact original manually before retrying', evidence);
  }
  const restored = original === null
    ? git(worktree, ['config', '--worktree', '--unset', 'core.hooksPath'])
    : git(worktree, ['config', '--worktree', 'core.hooksPath', original]);
  if (!restored.ok) {
    return refuse('manager_push_guard_local_route_restore_failed',
      'repair core.hooksPath in this exact worktree and retry the Claude-family manager launch', evidence);
  }
  const expected = safeReal(original ?? join(common, 'hooks'));
  if (effectiveHooksDir(worktree) !== expected) {
    return refuse('manager_push_guard_local_route_restore_unverified',
      'inspect the worktree and inherited hook configuration; B5 removal cannot be verified, so no Claude-family start is authorized', evidence);
  }
  for (const key of Object.values(KEY)) {
    if (worktreeConfig(worktree, key) !== null
      && !git(worktree, ['config', '--worktree', '--unset', key]).ok) {
      return refuse('manager_push_guard_local_route_cleanup_failed',
        'repair the remaining B5 config keys in this worktree, preserve sibling hooks and retry before starting Claude', evidence);
    }
  }
  return { ok: true, evidence: { ...evidence, guard: 'restored', originalHooksPath: original ?? 'unset' } };
}

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
