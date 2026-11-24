#!/usr/bin/env node
// Read-only weekly retrospective over Browser-GPT terminal envelopes and local
// default-branch integration history (Issue #2889). It never writes files,
// fetches, checks out, or contacts a browser/runtime. Correlation only.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.mjs';

export const TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1';
export const TERMINAL_SUFFIX = 'terminal.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;
const MAX_SCAN_DEPTH = 3;
const MAX_FILE_BYTES = 1024 * 1024;
const TOP_CAUSES = 15;
const GENERIC_INCIDENT_PREFIX = 'child_turn_state:';

const HELP = `Usage: node scripts/browser-gpt-weekly-report.mjs --repo-root <pack-checkout> [options]

Read-only plain-text retrospective of Browser-GPT terminal attempts and
default-branch integrations. Writes nothing; no fetch, checkout, browser,
daemon or runtime calls.

Options:
  --repo-root <dir>       Pack checkout whose LOCAL default-branch history is read (required).
  --days <N>              Positive whole number of rolling 24-hour days (default 7, max ${MAX_DAYS}).
  --until <timestamp>     UTC end of the window, exclusive, ISO-8601 with Z or an offset
                          (default: invocation time). Window is half-open [until - N*24h, until).
  --envelope-root <dir>   Extra envelope root (historical/OpenCode); repeatable. Supplements
                          the primary root, never replaces it.
  --primary-root <dir>    Replace the primary root (for isolated testing).
                          Default primary root: $HOME/.local/state/orchestrator-pack.
  --default-ref <ref>     Local default-branch ref to use when checkout metadata
                          (refs/remotes/origin/HEAD) is unavailable.
  -h, --help              Show this help.

Inputs: files named *${TERMINAL_SUFFIX} (schema ${TERMINAL_SCHEMA}) found up to
depth ${MAX_SCAN_DEPTH} under each root (symlinks are not followed). One terminal attempt =
one (run_identity, attempt_identity); identical repeats count once, conflicting repeats
are excluded and reported. Malformed/unreadable/unsupported files are counted and skipped.

Time semantics: all times UTC. Daily rows are the UTC calendar days intersecting the
window, clipped to it (partial days are marked). Incident share = attempts with
lifecycle_outcome=incident / all valid terminal attempts, by terminal_at. These are
terminal attempts, not successful sends and not non-ok turn-result rates.

Cause key (incident attempts only): the specific lifecycle "incident" label; for a
generic child_turn_state:* wrapper, "<wrapper>|<turn_result_cause>" when the result cause
is a safe label, else the wrapper; with no usable incident label, the safe
turn_result_cause; else "unknown". Unsafe text is never printed.

Integrations: first-parent history of the default branch. "Merge pull request #N" merge
commits and single-parent commits whose subject ends in "(#N)" identify a PR; others are
listed with unknown PR metadata. Each integration is diffed against its first parent.
Browser-GPT turn production selector (net changed paths):
  scripts/chatgpt-browser-turn/** production sources (excluding *.test.*, *.test-*.ts,
    *-fixture.ts, fixtures/**, non-.ts files), scripts/chatgpt-browser-turn.ts,
  scripts/flow-manager-browser-gpt-long-run.ts, scripts/flow-manager-long-running-child.ts.
For each such PR: 24h before [t-24h, t) vs 24h after [t, t+24h) clipped to --until
(marked incomplete). Correlation only, not causation; no thresholds or verdicts.
`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { days: 7, extraRoots: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '--repo-root': opts.repoRoot = value(); break;
      case '--days': {
        const raw = value();
        if (!/^[0-9]+$/u.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DAYS) {
          throw new UsageError(`--days must be a whole number from 1 to ${MAX_DAYS}, got "${raw}"`);
        }
        opts.days = Number(raw);
        break;
      }
      case '--until': {
        const raw = value();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/u.test(raw)
          || !Number.isFinite(Date.parse(raw))) {
          throw new UsageError(`--until must be an ISO-8601 timestamp with Z or an offset, got "${raw}"`);
        }
        opts.untilMs = Date.parse(raw);
        break;
      }
      case '--envelope-root': opts.extraRoots.push(value()); break;
      case '--primary-root': opts.primaryRoot = value(); break;
      case '--default-ref': opts.defaultRef = value(); break;
      default: throw new UsageError(`unknown argument "${arg}" (see --help)`);
    }
  }
  if (!opts.help && !opts.repoRoot) throw new UsageError('--repo-root <pack-checkout> is required');
  return opts;
}

// ---------- labels ----------

/** A safe label: short single token of [A-Za-z0-9_.:-], without long hex/uuid-like runs. */
export function safeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,95}$/u.test(v)) return undefined;
  if (/[0-9a-f]{16,}/iu.test(v.replace(/[-_:]/gu, ''))) return undefined;
  return v;
}

export function causeKey(env) {
  if (env.lifecycle_outcome !== 'incident') return undefined;
  const incident = safeLabel(env.incident);
  const result = safeLabel(env.turn_result_cause);
  if (incident && incident.startsWith(GENERIC_INCIDENT_PREFIX)) {
    return result ? `${incident}|${result}` : incident;
  }
  if (incident) return incident;
  return result ?? 'unknown';
}

// ---------- envelopes ----------

function displayPath(p) {
  const home = homedir();
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

function listEnvelopeFiles(root, depth, out) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    out.unreadableDirs += 1;
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SCAN_DEPTH) listEnvelopeFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(TERMINAL_SUFFIX)) {
      out.files.push(full);
    }
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'malformed';
  if (body.schema !== TERMINAL_SCHEMA) return 'unsupported';
  if (typeof body.run_identity !== 'string' || !body.run_identity.trim()
    || typeof body.attempt_identity !== 'string' || !body.attempt_identity.trim()) return 'invalid';
  if (typeof body.terminal_at !== 'string' || !Number.isFinite(Date.parse(body.terminal_at))) return 'invalid';
  if (body.lifecycle_outcome !== 'success' && body.lifecycle_outcome !== 'incident') return 'invalid';
  return undefined;
}

export function loadObservations(roots) {
  const coverage = [];
  const skipped = { unreadable: 0, malformed: 0, unsupported: 0, invalid: 0 };
  const byIdentity = new Map();
  let duplicateFiles = 0;
  for (const root of roots) {
    const record = { label: root.label, path: displayPath(root.path), available: false, files: 0, unreadableDirs: 0 };
    coverage.push(record);
    let stat;
    try {
      stat = lstatSync(root.path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    record.available = true;
    const scan = { files: [], unreadableDirs: 0 };
    listEnvelopeFiles(root.path, 0, scan);
    record.files = scan.files.length;
    record.unreadableDirs = scan.unreadableDirs;
    for (const file of scan.files) {
      let text;
      try {
        if (lstatSync(file).size > MAX_FILE_BYTES) { skipped.unreadable += 1; continue; }
        text = readFileSync(file, 'utf8');
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        skipped.malformed += 1;
        continue;
      }
      const problem = validateEnvelope(body);
      if (problem) { skipped[problem] += 1; continue; }
      const id = `${body.run_identity}\u0000${body.attempt_identity}`;
      const canonical = stableStringify(body);
      const seen = byIdentity.get(id);
      if (!seen) {
        byIdentity.set(id, { body, canonical, conflict: false });
      } else {
        duplicateFiles += 1;
        if (seen.canonical !== canonical) seen.conflict = true;
      }
    }
  }
  const observations = [];
  let conflictingIdentities = 0;
  for (const entry of byIdentity.values()) {
    if (entry.conflict) { conflictingIdentities += 1; continue; }
    observations.push({
      atMs: Date.parse(entry.body.terminal_at),
      incident: entry.body.lifecycle_outcome === 'incident',
      cause: causeKey(entry.body),
    });
  }
  observations.sort((a, b) => a.atMs - b.atMs);
  return { coverage, skipped, duplicateFiles, conflictingIdentities, observations };
}

// ---------- git ----------

function git(repoRoot, args) {
  const result = runProcessSync({
    command: 'git',
    args: ['-C', repoRoot, '--no-pager', ...args],
    inheritParentEnv: true,
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${oneLine(result.error ?? result.stderr ?? '', 300) || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return undefined;
  }
}

export function resolveDefaultRef(repoRoot, explicitRef) {
  if (tryGit(repoRoot, ['rev-parse', '--git-dir']) === undefined) {
    throw new UsageError(`--repo-root ${repoRoot} is not a readable Git checkout`);
  }
  const candidates = [];
  let source;
  const originHead = tryGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (originHead && originHead.startsWith('refs/remotes/origin/')) {
    const name = originHead.slice('refs/remotes/origin/'.length);
    candidates.push(`refs/heads/${name}`, originHead);
    source = 'checkout metadata refs/remotes/origin/HEAD';
  } else if (explicitRef) {
    candidates.push(explicitRef);
    source = 'explicit --default-ref';
  } else {
    throw new UsageError('cannot resolve the default branch: refs/remotes/origin/HEAD is unset; '
      + 'pass --default-ref <local default ref> (e.g. refs/heads/main)');
  }
  for (const ref of candidates) {
    const sha = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
    if (sha) return { ref, sha, source };
  }
  throw new UsageError(`default-branch ref ${candidates.join(' / ')} does not resolve to a local commit`);
}

export function isBrowserGptTurnPath(path) {
  if (path === 'scripts/chatgpt-browser-turn.ts'
    || path === 'scripts/flow-manager-browser-gpt-long-run.ts'
    || path === 'scripts/flow-manager-long-running-child.ts') return true;
  if (!path.startsWith('scripts/chatgpt-browser-turn/')) return false;
  const rest = path.slice('scripts/chatgpt-browser-turn/'.length);
  if (rest.split('/').some((seg) => seg === 'fixtures' || seg === '__fixtures__')) return false;
  if (!rest.endsWith('.ts')) return false;
  if (/\.test[.-]/u.test(rest) || /-fixture\.ts$/u.test(rest)) return false;
  return true;
}

function parseIntegration(parents, subject, body) {
  const merge = /^Merge pull request #([0-9]+) from \S+/u.exec(subject);
  if (merge && parents.length > 1) {
    const title = body.split('\n').map((l) => l.trim()).find(Boolean);
    return { pr: Number(merge[1]), title: title ?? undefined, kind: 'merge' };
  }
  const squash = /^(.*\S)\s+\(#([0-9]+)\)$/u.exec(subject);
  if (squash && parents.length <= 1) return { pr: Number(squash[2]), title: squash[1], kind: 'squash' };
  return { pr: undefined, title: undefined, kind: parents.length > 1 ? 'merge' : 'commit' };
}

export function readIntegrations(repoRoot, ref, startMs, untilMs) {
  const sep = '\u001f';
  const rec = '\u001e';
  const out = git(repoRoot, [
    'log', '--first-parent', `--since=@${Math.floor(startMs / 1000) - 1}`,
    `--format=%H${sep}%P${sep}%ct${sep}%s${rec}`, ref, '--',
  ]);
  const items = [];
  const seenPr = new Set();
  let duplicatePrMarkers = 0;
  for (const raw of out.split(rec)) {
    const chunk = raw.replace(/^\n/u, '');
    if (!chunk.trim()) continue;
    const [sha, parentsRaw, ct, subject] = chunk.split(sep);
    const atMs = Number(ct) * 1000;
    if (!(atMs >= startMs && atMs < untilMs)) continue;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(' ') : [];
    const body = parents.length > 1 && /^Merge pull request #/u.test(subject)
      ? git(repoRoot, ['log', '-1', '--format=%b', sha, '--'])
      : '';
    const meta = parseIntegration(parents, subject, body);
    items.push({ sha, parents, atMs, subject, ...meta });
  }
  items.sort((a, b) => a.atMs - b.atMs || a.sha.localeCompare(b.sha));
  const unique = [];
  for (const item of items) {
    if (item.pr !== undefined) {
      if (seenPr.has(item.pr)) { duplicatePrMarkers += 1; continue; }
      seenPr.add(item.pr);
    }
    const diffArgs = item.parents.length > 0
      ? ['diff', '--no-renames', '--name-only', '-z', item.parents[0], item.sha, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', item.sha, '--'];
    const paths = git(repoRoot, diffArgs).split('\u0000').filter(Boolean);
    item.relevant = paths.some(isBrowserGptTurnPath);
    unique.push(item);
  }
  return { integrations: unique, duplicatePrMarkers };
}

// ---------- aggregation ----------

function summarize(observations, fromMs, toMs) {
  let total = 0;
  let incidents = 0;
  const causes = new Map();
  for (const o of observations) {
    if (o.atMs < fromMs || o.atMs >= toMs) continue;
    total += 1;
    if (o.incident) {
      incidents += 1;
      causes.set(o.cause, (causes.get(o.cause) ?? 0) + 1);
    }
  }
  return { total, incidents, causes };
}

function sortedCauses(causes) {
  return [...causes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function share(s) {
  if (s.total === 0) return 'N/A';
  return `${((s.incidents / s.total) * 100).toFixed(1)}%`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function oneLine(text, max = 100) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function buildReport(opts) {
  const untilMs = opts.untilMs ?? Date.now();
  const startMs = untilMs - opts.days * DAY_MS;
  const repoRoot = resolve(opts.repoRoot);
  const primary = resolve(opts.primaryRoot ?? join(homedir(), '.local', 'state', 'orchestrator-pack'));
  const roots = [{ label: opts.primaryRoot ? 'primary (explicit)' : 'primary (default)', path: primary }];
  opts.extraRoots.forEach((r, i) => roots.push({ label: `extra #${i + 1}`, path: resolve(r) }));
  for (const r of [opts.repoRoot, opts.primaryRoot, ...opts.extraRoots]) {
    if (r !== undefined && !r.trim()) throw new UsageError('empty path argument');
  }

  const ref = resolveDefaultRef(repoRoot, opts.defaultRef);
  const { integrations, duplicatePrMarkers } = readIntegrations(repoRoot, ref.sha, startMs, untilMs);
  const data = loadObservations(roots);
  const obs = data.observations;
  const L = [];

  L.push('Browser-GPT weekly report (read-only; correlation only, not causation)');
  L.push(`Window (UTC, half-open): [${iso(startMs)}, ${iso(untilMs)}) — ${opts.days} x 24h`);
  L.push(`Default branch: ${ref.ref} @ ${ref.sha} (resolved from ${ref.source})`);
  L.push('Unit: terminal attempts (distinct run/attempt identities), not successful sends and not non-ok turn-result rates.');
  L.push('');
  L.push('Source coverage:');
  for (const c of data.coverage) {
    L.push(c.available
      ? `  ${c.label}: ${c.path} — ${c.files} envelope file(s)${c.unreadableDirs ? `, ${c.unreadableDirs} unreadable dir(s)` : ''}`
      : `  ${c.label}: ${c.path} — UNAVAILABLE (missing or not a directory)`);
  }
  const sk = data.skipped;
  L.push(`  skipped files: unreadable ${sk.unreadable}, malformed JSON ${sk.malformed}, unsupported schema ${sk.unsupported}, invalid fields ${sk.invalid}`);
  L.push(`  duplicate files of an already-seen attempt: ${data.duplicateFiles}; conflicting attempt identities excluded: ${data.conflictingIdentities}`);
  L.push(`  valid distinct terminal attempts (all time): ${obs.length}`);
  const noData = obs.length === 0;
  if (noData) L.push('  NO DATA: no valid terminal envelopes in the scanned roots; shares below are N/A, not zero.');
  L.push('');

  L.push('Daily (UTC calendar days; incidents/total = share):');
  const firstDay = Math.floor(startMs / DAY_MS) * DAY_MS;
  for (let day = firstDay; day < untilMs; day += DAY_MS) {
    const from = Math.max(day, startMs);
    const to = Math.min(day + DAY_MS, untilMs);
    const s = summarize(obs, from, to);
    const partial = from !== day || to !== day + DAY_MS ? ` partial [${iso(from).slice(11, 19)}, ${to === day + DAY_MS ? '24:00:00' : iso(to).slice(11, 19)})` : '';
    const tail = noData ? ' (no data)' : '';
    L.push(`  ${iso(day).slice(0, 10)}${partial}: ${s.incidents}/${s.total} incident ${share(s)}${tail}`);
  }
  const win = summarize(obs, startMs, untilMs);
  L.push(`  window total: ${win.incidents}/${win.total} incident ${share(win)}`);
  L.push('');
  L.push(`Top incident causes in window (incident attempts only; showing up to ${TOP_CAUSES}):`);
  const top = sortedCauses(win.causes);
  if (top.length === 0) L.push(noData ? '  (no data)' : '  (none)');
  for (const [k, n] of top.slice(0, TOP_CAUSES)) L.push(`  ${n}  ${k}`);
  if (top.length > TOP_CAUSES) L.push(`  … ${top.length - TOP_CAUSES} more cause key(s)`);
  L.push('');

  L.push('Default-branch integrations in window (first-parent):');
  const unknownMeta = integrations.filter((i) => i.pr === undefined).length;
  if (integrations.length === 0) L.push('  (none)');
  for (const i of integrations) {
    const pr = i.pr !== undefined ? `PR #${i.pr}` : 'PR unknown';
    const title = i.pr !== undefined ? (i.title ? oneLine(i.title) : 'title unknown') : `subject: ${oneLine(i.subject)}`;
    L.push(`  ${iso(i.atMs)}  ${i.sha.slice(0, 12)}  ${pr}  ${i.relevant ? '[browser-gpt]' : '[other]'}  ${title}`);
  }
  if (unknownMeta > 0) L.push(`  coverage limitation: ${unknownMeta} integration(s) without identifiable PR metadata`);
  if (duplicatePrMarkers > 0) L.push(`  ${duplicatePrMarkers} repeated PR marker(s) skipped (each PR counted once)`);
  L.push('');

  L.push('Browser-GPT merge comparisons (24h before vs 24h after; correlation only, not causation):');
  const relevant = integrations.filter((i) => i.relevant && i.pr !== undefined);
  const relevantUnknown = integrations.filter((i) => i.relevant && i.pr === undefined).length;
  if (relevant.length === 0) L.push('  (no identified Browser-GPT PR integrations in window)');
  if (relevantUnknown > 0) L.push(`  ${relevantUnknown} Browser-GPT-touching integration(s) without PR metadata not compared`);
  for (const i of relevant) {
    const bFrom = i.atMs - DAY_MS;
    const aTo = Math.min(i.atMs + DAY_MS, untilMs);
    const clipped = aTo < i.atMs + DAY_MS;
    const before = summarize(obs, bFrom, i.atMs);
    const after = summarize(obs, i.atMs, aTo);
    L.push(`  PR #${i.pr} ${i.sha.slice(0, 12)} at ${iso(i.atMs)}${i.title ? ` — ${oneLine(i.title)}` : ''}`);
    L.push(`    before [${iso(bFrom)}, ${iso(i.atMs)}): ${before.incidents}/${before.total} incident ${share(before)}`);
    L.push(`    after  [${iso(i.atMs)}, ${iso(aTo)})${clipped ? ' INCOMPLETE (clipped to --until)' : ''}: ${after.incidents}/${after.total} incident ${share(after)}`);
    for (const [name, s] of [['before', before], ['after', after]]) {
      const list = sortedCauses(s.causes);
      L.push(`    ${name} causes: ${list.length ? list.map(([k, n]) => `${k}=${n}`).join(', ') : '(none)'}`);
    }
    if (before.total === 0 || after.total === 0) {
      L.push('    comparison: N/A (a side has zero observations; no directional conclusion)');
    }
    if (before.total === 0) {
      L.push('    newly observed causes: comparison unavailable (no before data)');
    } else {
      const fresh = sortedCauses(after.causes).filter(([k]) => !before.causes.has(k));
      L.push(`    newly observed causes (after>0, before=0; not necessarily novel defects): ${fresh.length ? fresh.map(([k, n]) => `${k}=${n}`).join(', ') : '(none)'}`);
    }
  }
  L.push('');
  L.push('Limitations: overlapping merge windows, bursts, varying denominators and missing or skipped files');
  L.push('limit these comparisons; they are not attributed effects, ratings or verdicts.');
  return `${L.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(HELP);
      return 0;
    }
    process.stdout.write(buildReport(opts));
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof UsageError ? 'browser-gpt-weekly-report: ' : 'browser-gpt-weekly-report: git history unusable: ';
    process.stderr.write(`${prefix}${oneLine(msg, 400)}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
