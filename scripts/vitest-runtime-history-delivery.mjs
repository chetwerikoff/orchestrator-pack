#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TARGET_REPOSITORY = 'chetwerikoff/orchestrator-pack';
export const DELIVERY_BRANCH = 'ci/vitest-runtime-history-refresh';
export const DELIVERY_BASE = 'main';
export const DELIVERY_PATH = 'scripts/vitest-runtime-history.json';
export const PACK_REVIEW_CONTEXT = 'orchestrator-pack/pack-review';
export const PROVENANCE_CONTEXT = 'orchestrator-pack/runtime-history-provenance';
export const MACHINE_ADMISSION_MARKER = 'runtime-history-machine-admission';
export const REFRESH_WORKFLOW_PATH = '.github/workflows/vitest-runtime-history-refresh.yml';
export const DEFAULT_WAIT_SECONDS = 900;
export const DEFAULT_POLL_SECONDS = 15;

const SHA_RE = /^[0-9a-f]{40}$/i;
const PROVENANCE_RE = /^runtime-history-provenance run=(\d+) attempt=(\d+) source=([0-9a-f]{40})$/i;
const FAIL = new Set(['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required']);
const PASS = new Set(['success', 'successful', 'neutral', 'skipped', 'skipping']);
const WAIT = new Set(['pending', 'queued', 'requested', 'waiting', 'in_progress']);

const fail = (outcome, reason) => ({ ok: false, outcome, reason });
const orderKey = (row) => {
  const id = Number(row?.id);
  const createdAt = Date.parse(row?.created_at ?? '');
  return Number.isSafeInteger(id) && id > 0 && Number.isFinite(createdAt) ? { id, createdAt } : null;
};

export function validateDeliveryFiles(files, expectedPath = DELIVERY_PATH) {
  const names = Array.isArray(files) ? files.map((x) => x?.filename).filter(Boolean) : [];
  return Array.isArray(files) && files.length === 1 && names.length === 1 && names[0] === expectedPath
    ? { ok: true }
    : fail('scope-invalid', `delivery PR must change only ${expectedPath}; saw ${names.join(', ') || '<none>'}`);
}

export function validateSanctionedIdentity({ repo, pr, expectedHeadSha, trustedActor, eventSender }) {
  if (repo !== TARGET_REPOSITORY) return fail('identity-invalid', `repository ${repo} is not sanctioned`);
  if (!SHA_RE.test(expectedHeadSha ?? '')) return fail('identity-invalid', 'expected head sha is invalid');
  if (!trustedActor || trustedActor !== eventSender) return fail('identity-invalid', 'delivery event sender does not match the trusted delivery actor');
  if (pr?.base?.ref !== DELIVERY_BASE) return fail('identity-invalid', `delivery base must be ${DELIVERY_BASE}`);
  if (pr?.head?.ref !== DELIVERY_BRANCH) return fail('identity-invalid', `delivery head branch must be ${DELIVERY_BRANCH}`);
  if (pr?.head?.repo?.full_name !== TARGET_REPOSITORY) return fail('identity-invalid', 'delivery head must come from the same repository');
  if (pr?.head?.sha !== expectedHeadSha) return fail('non-generated-head', `PR head ${pr?.head?.sha ?? '<missing>'} does not equal generated head ${expectedHeadSha}`);
  return { ok: true };
}

export function projectPackReviewStatusHistory(history) {
  if (!Array.isArray(history)) return fail('status-history-unprovable', 'status history is not an array');
  const rows = [];
  const ids = new Set();
  for (const row of history.filter((x) => x?.context === PACK_REVIEW_CONTEXT)) {
    const key = orderKey(row);
    const state = String(row?.state ?? '').toLowerCase();
    if (!key || ids.has(key.id) || !['success', 'pending', 'failure', 'error'].includes(state)) {
      return fail('status-history-unprovable', 'malformed or duplicate pack-review status record');
    }
    ids.add(key.id);
    const machine = String(row?.description ?? '') === MACHINE_ADMISSION_MARKER;
    if (machine && row?.creator?.login !== 'github-actions[bot]') {
      return fail('status-history-unprovable', 'machine-admission marker was emitted by a non-repository-owned writer');
    }
    rows.push({ ...key, state, machine, row });
  }
  rows.sort((a, b) => a.id - b.id);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].createdAt < rows[i - 1].createdAt) return fail('status-history-unprovable', 'status id/time ordering is ambiguous');
  }
  const oob = rows.filter((x) => !x.machine).at(-1) ?? null;
  const machineSuccess = rows.some((x) => x.machine && x.state === 'success');
  if (!oob) return { ok: true, state: 'absent', machineSuccess, latestOutOfBand: null };
  if (oob.state === 'success') return { ok: true, state: 'success', machineSuccess, latestOutOfBand: oob.row };
  if (oob.state === 'pending') return { ok: true, state: 'pending', machineSuccess, latestOutOfBand: oob.row };
  return { ok: true, state: 'veto', machineSuccess, latestOutOfBand: oob.row, outcome: 'operator-veto-observed' };
}

export function parseRefreshProvenance(history, expectedHeadSha) {
  if (!Array.isArray(history)) return fail('status-history-unprovable', 'status history is not an array');
  if (!SHA_RE.test(expectedHeadSha ?? '')) return fail('provenance-invalid', 'expected head sha is invalid');
  const source = history.filter((x) => x?.context === PROVENANCE_CONTEXT);
  if (source.length === 0) return fail('provenance-invalid', 'refresh provenance status is missing');
  const rows = [];
  const ids = new Set();
  for (const row of source) {
    const key = orderKey(row);
    const state = String(row?.state ?? '').toLowerCase();
    const match = String(row?.description ?? '').match(PROVENANCE_RE);
    if (!key || ids.has(key.id) || !match || !['pending', 'success', 'failure', 'error'].includes(state)) {
      return fail('provenance-invalid', 'refresh provenance status is malformed or ambiguous');
    }
    const runId = Number(match[1]);
    const runAttempt = Number(match[2]);
    if (row?.creator?.login !== 'github-actions[bot]' || row?.target_url !== `https://github.com/${TARGET_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`) {
      return fail('provenance-invalid', 'refresh provenance status is not a trusted repository-owned run output');
    }
    ids.add(key.id);
    rows.push({ ...key, state, runId, runAttempt, sourceMainSha: match[3].toLowerCase(), row });
  }
  rows.sort((a, b) => a.id - b.id);
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    if (b.createdAt < a.createdAt || b.runId !== a.runId || b.runAttempt !== a.runAttempt || b.sourceMainSha !== a.sourceMainSha) {
      return fail('provenance-invalid', 'refresh provenance records do not bind one episode');
    }
  }
  return { ok: true, exactHeadSha: expectedHeadSha.toLowerCase(), ...rows.at(-1) };
}

export function verifyRefreshRun(run, provenance) {
  if (!run || typeof run !== 'object') return fail('provenance-invalid', 'refresh workflow run is unavailable');
  if (Number(run.id) !== provenance.runId || Number(run.run_attempt) !== provenance.runAttempt || run.repository?.full_name !== TARGET_REPOSITORY || run.path !== REFRESH_WORKFLOW_PATH || String(run.head_sha ?? '').toLowerCase() !== provenance.sourceMainSha) {
    return fail('provenance-invalid', 'refresh workflow run does not match provenance binding');
  }
  if (String(run.status ?? '').toLowerCase() !== 'completed') return { ok: true, state: 'pending', reason: 'refresh workflow episode has not completed' };
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  return conclusion === 'success' && provenance.state === 'success'
    ? { ok: true, state: 'success' }
    : fail('provenance-invalid', `refresh workflow episode ended ${conclusion || provenance.state}`);
}

export function normalizeCurrentRequiredPolicy(policy) {
  if (!policy || typeof policy !== 'object' || typeof policy.strict !== 'boolean') return fail('current-policy-unavailable', 'current main required-status policy is malformed');
  const source = Array.isArray(policy.checks) ? policy.checks : Array.isArray(policy.contexts) ? policy.contexts.map((context) => ({ context, app_id: null })) : null;
  if (!source) return fail('current-policy-unsupported', 'current main required-status policy has no checks/contexts list');
  const seen = new Set();
  const checks = [];
  for (const raw of source) {
    const context = typeof raw === 'string' ? raw : raw?.context;
    const appId = typeof raw === 'object' && raw !== null ? (raw.app_id ?? null) : null;
    if (!context || typeof context !== 'string' || seen.has(context)) return fail('current-policy-unsupported', 'current policy contains malformed or duplicate required checks');
    if (appId !== null) {
      if (!Number.isSafeInteger(Number(appId)) || Number(appId) <= 0) return fail('current-policy-unsupported', `invalid app restriction for ${context}`);
      return fail('current-policy-unsupported', `provider/app restriction for ${context} cannot be proven by the current pr-checks transport`);
    }
    seen.add(context);
    checks.push({ context, appId: null });
  }
  return { ok: true, strict: policy.strict, checks, names: checks.map((x) => x.context) };
}

function checkState(check) {
  const states = [check?.bucket, check?.state].filter(Boolean).map((x) => String(x).toLowerCase());
  if (states.some((x) => FAIL.has(x))) return 'fail';
  if (states.some((x) => WAIT.has(x))) return 'pending';
  if (states.some((x) => PASS.has(x))) return 'pass';
  return 'pending';
}

export function evaluateRequiredChecks({ checks, policy, packReviewProjection, machineAdmissionAttempted = false }) {
  if (!Array.isArray(checks)) return { action: 'fail', outcome: 'current-checks-unavailable', reason: 'current checks payload is malformed' };
  if (!policy?.ok) return { action: 'fail', outcome: policy?.outcome ?? 'current-policy-unavailable', reason: policy?.reason ?? 'current policy unavailable' };
  const byName = new Map(checks.filter((x) => x?.name).map((x) => [String(x.name), checkState(x)]));
  const ordinary = policy.names.filter((x) => x !== PACK_REVIEW_CONTEXT);
  const failed = ordinary.filter((x) => byName.get(x) === 'fail');
  if (failed.length) return { action: 'fail', outcome: 'required-check-failed', reason: `required checks failed: ${failed.join(', ')}` };
  const pending = ordinary.filter((x) => byName.get(x) === 'pending');
  if (pending.length) return { action: 'wait', outcome: 'required-check-pending', reason: `required checks pending: ${pending.join(', ')}` };
  const missing = ordinary.filter((x) => !byName.has(x));
  if (missing.length) {
    if (checks.length === 0 || checks.some((x) => checkState(x) === 'pending')) return { action: 'wait', outcome: 'required-check-pending', reason: `required checks not reported yet: ${missing.join(', ')}` };
    return { action: 'fail', outcome: 'required-context-unreported', reason: `required contexts unreported: ${missing.join(', ')}` };
  }
  if (!policy.names.includes(PACK_REVIEW_CONTEXT)) return { action: 'ready', reason: 'all current required checks pass; pack-review is not required' };
  if (!packReviewProjection?.ok) return { action: 'fail', outcome: packReviewProjection?.outcome ?? 'status-history-unprovable', reason: packReviewProjection?.reason ?? 'pack-review status history unavailable' };
  if (packReviewProjection.state === 'veto') return { action: 'fail', outcome: 'operator-veto-observed', reason: 'latest out-of-band pack-review state is failure/error' };
  if (packReviewProjection.state === 'pending') return { action: 'wait', outcome: 'operator-status-pending', reason: 'latest out-of-band pack-review state is pending' };
  if (packReviewProjection.state === 'success') return { action: 'ready', reason: 'pack-review is satisfied by latest out-of-band success' };
  if (!packReviewProjection.machineSuccess) {
    if (machineAdmissionAttempted) {
      return { action: 'fail', outcome: 'required-context-unreported', reason: 'machine admission was attempted but exact-head status history does not report it' };
    }
    return { action: 'machine-admit', reason: 'pack-review is required and no out-of-band status exists' };
  }
  const current = byName.get(PACK_REVIEW_CONTEXT);
  if (current === 'pass') return { action: 'ready', reason: 'pack-review is satisfied by machine admission' };
  if (current === 'fail') return { action: 'fail', outcome: 'required-check-failed', reason: 'current pack-review context is failing' };
  if (current === 'pending') return { action: 'wait', outcome: 'required-check-pending', reason: 'current pack-review context is pending' };
  return { action: 'fail', outcome: 'required-context-unreported', reason: 'machine admission exists but current required pack-review context is unreported' };
}

function ghCommand(repoRoot) { return join(repoRoot, 'scripts', 'gh'); }
function runGh(repoRoot, args, options = {}) {
  const result = spawnSync(ghCommand(repoRoot), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.status ?? 1)) throw new Error(`gh ${args.join(' ')} failed (exit ${result.status ?? 'null'}): ${result.stderr || result.stdout}`);
  return result;
}
function runGhJson(root, args, options = {}) {
  const text = runGh(root, args, options).stdout.trim();
  return text ? JSON.parse(text) : null;
}
function normalizeRepo(value) {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`invalid repo: ${value}`);
  return { owner: parts[0], repo: parts[1] };
}

export function selectReusableDeliveryPr(pulls) { return Array.isArray(pulls) ? pulls.find((x) => x?.state === 'open') ?? null : null; }
export function closeObsoleteDeliveryPr({ repoRoot, repo, prNumber, reason, runCommand = runGh }) {
  runCommand(repoRoot, ['pr', 'close', String(prNumber), '--repo', repo, '--comment', `Closing obsolete runtime-history delivery PR: ${reason}. A later refresh trigger will regenerate it from current main.`], { allowedExitCodes: [0] });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRealIo(options) {
  const { owner, repo } = normalizeRepo(options.repo);
  const n = String(options.prNumber);
  return {
    getPr: () => runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/pulls/${n}`]),
    getFiles: () => runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/pulls/${n}/files?per_page=100`]) ?? [],
    getChecks: () => {
      const r = runGh(options.repoRoot, ['pr', 'checks', n, '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'], { allowedExitCodes: [0, 1, 8] });
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    },
    getPolicy: () => runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/branches/${DELIVERY_BASE}/protection/required_status_checks`]),
    getStatusHistory: (sha) => runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/commits/${sha}/statuses`]) ?? [],
    getActionsRun: (id) => runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/actions/runs/${id}`]),
    publishMachineAdmission(sha) {
      const token = process.env.MACHINE_STATUS_TOKEN;
      if (!token) throw new Error('MACHINE_STATUS_TOKEN is required for repository-owned machine admission');
      const previous = process.env.GH_TOKEN;
      process.env.GH_TOKEN = token;
      try {
        return runGhJson(options.repoRoot, ['api', '-X', 'POST', `repos/${owner}/${repo}/statuses/${sha}`, '-f', 'state=success', '-f', `context=${PACK_REVIEW_CONTEXT}`, '-f', `description=${MACHINE_ADMISSION_MARKER}`]);
      } finally {
        if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
      }
    },
    merge: (headSha) => runGhJson(options.repoRoot, ['api', '-X', 'PUT', `repos/${owner}/${repo}/pulls/${n}/merge`, '-f', 'merge_method=squash', '-f', `sha=${headSha}`]),
    closeObsolete: (reason) => closeObsoleteDeliveryPr({ repoRoot: options.repoRoot, repo: options.repo, prNumber: options.prNumber, reason }),
    sleep,
  };
}

async function inspect(config, io) {
  const pr = await io.getPr();
  const identity = validateSanctionedIdentity({ ...config, pr });
  if (!identity.ok) return { terminal: true, ...identity, pr };
  const files = await io.getFiles();
  const scope = validateDeliveryFiles(files);
  if (!scope.ok) return { terminal: true, ...scope, pr };
  if (pr?.mergeable === false || pr?.mergeable_state === 'dirty') return { terminal: true, ...fail('close-as-obsolete', 'delivery PR is conflicted or unmergeable'), pr };
  if (pr?.mergeable === null || pr?.mergeable_state === 'unknown') return { wait: true, outcome: 'mergeability-pending', reason: 'delivery PR mergeability still computing', pr };
  let history;
  try { history = await io.getStatusHistory(config.expectedHeadSha); }
  catch (e) { return { terminal: true, ...fail('status-history-unprovable', `status history read failed: ${e.message}`), pr }; }
  const provenance = parseRefreshProvenance(history, config.expectedHeadSha);
  if (!provenance.ok) return { terminal: true, ...provenance, pr };
  let run;
  try { run = await io.getActionsRun(provenance.runId); }
  catch (e) { return { terminal: true, ...fail('provenance-invalid', `refresh run read failed: ${e.message}`), pr }; }
  const runProof = verifyRefreshRun(run, provenance);
  if (!runProof.ok) return { terminal: true, ...runProof, pr };
  if (runProof.state === 'pending') return { wait: true, outcome: 'provenance-pending', reason: runProof.reason, pr };
  let rawPolicy;
  try { rawPolicy = await io.getPolicy(); }
  catch (e) { return { terminal: true, ...fail('current-policy-unavailable', `current main policy read failed: ${e.message}`), pr }; }
  const policy = normalizeCurrentRequiredPolicy(rawPolicy);
  if (!policy.ok) return { terminal: true, ...policy, pr };
  const projection = projectPackReviewStatusHistory(history);
  if (!projection.ok) return { terminal: true, ...projection, pr };
  if (projection.state === 'veto') return { terminal: true, ...fail('operator-veto-observed', 'latest out-of-band pack-review status is failure/error'), pr };
  if (projection.state === 'pending') return { wait: true, outcome: 'operator-status-pending', reason: 'latest out-of-band pack-review status is pending', pr };
  return { ok: true, pr, files, history, provenance, run, policy, projection, checks: await io.getChecks() };
}

export async function runDeliveryMonitor(config, io) {
  const deadline = Date.now() + config.waitSeconds * 1000;
  let attempted = false;
  let provenanceGrace = false;
  while (Date.now() <= deadline) {
    let state = await inspect(config, io);
    if (state.terminal && state.outcome === 'provenance-invalid' && state.reason === 'refresh provenance status is missing' && !provenanceGrace) {
      provenanceGrace = true; await io.sleep(config.pollSeconds * 1000); continue;
    }
    if (state.terminal) {
      if (state.outcome === 'close-as-obsolete') { await io.closeObsolete(state.reason); return { outcome: state.outcome, reason: state.reason }; }
      if (state.outcome === 'non-generated-head') return { outcome: state.outcome, reason: state.reason };
      return { outcome: state.outcome, reason: state.reason, failed: true };
    }
    if (state.wait) { await io.sleep(config.pollSeconds * 1000); continue; }
    let decision = evaluateRequiredChecks({ checks: state.checks, policy: state.policy, packReviewProjection: state.projection, machineAdmissionAttempted: attempted });
    if (decision.action === 'fail') return { outcome: decision.outcome, reason: decision.reason, failed: true };
    if (decision.action === 'wait') { await io.sleep(config.pollSeconds * 1000); continue; }
    if (decision.action === 'machine-admit') {
      try { await io.publishMachineAdmission(config.expectedHeadSha); } catch {}
      attempted = true;
      let history;
      try { history = await io.getStatusHistory(config.expectedHeadSha); }
      catch (e) { return { outcome: 'status-history-unprovable', reason: `post-publication status history read failed: ${e.message}`, failed: true }; }
      const projection = projectPackReviewStatusHistory(history);
      if (!projection.ok) return { outcome: projection.outcome, reason: projection.reason, failed: true };
      if (projection.state === 'veto') return { outcome: 'operator-veto-observed', reason: 'out-of-band pack-review veto observed after machine publication', failed: true };
      if (projection.state === 'pending') { await io.sleep(config.pollSeconds * 1000); continue; }
      if (!projection.machineSuccess) { await io.sleep(config.pollSeconds * 1000); continue; }
    }
    state = await inspect(config, io);
    if (state.terminal) {
      if (state.outcome === 'close-as-obsolete') { await io.closeObsolete(state.reason); return { outcome: state.outcome, reason: state.reason }; }
      if (state.outcome === 'non-generated-head') return { outcome: state.outcome, reason: state.reason };
      return { outcome: state.outcome, reason: state.reason, failed: true };
    }
    if (state.wait) { await io.sleep(config.pollSeconds * 1000); continue; }
    decision = evaluateRequiredChecks({ checks: state.checks, policy: state.policy, packReviewProjection: state.projection, machineAdmissionAttempted: attempted });
    if (decision.action === 'machine-admit' || decision.action === 'wait') { await io.sleep(config.pollSeconds * 1000); continue; }
    if (decision.action === 'fail') return { outcome: decision.outcome, reason: decision.reason, failed: true };
    let merged;
    try { merged = await io.merge(config.expectedHeadSha); }
    catch (e) {
      const rebound = await inspect(config, io);
      if (rebound.terminal) return { outcome: rebound.outcome, reason: `merge rejected and fresh state changed: ${rebound.reason}`, failed: rebound.outcome !== 'non-generated-head' };
      if (rebound.wait) { await io.sleep(config.pollSeconds * 1000); continue; }
      return { outcome: 'merge-rejected', reason: `expected-head merge request rejected: ${e.message}`, failed: true };
    }
    if (merged?.merged === false) {
      const rebound = await inspect(config, io);
      if (rebound.terminal) return { outcome: rebound.outcome, reason: `merge rejected and fresh state changed: ${rebound.reason}`, failed: rebound.outcome !== 'non-generated-head' };
      if (rebound.wait) { await io.sleep(config.pollSeconds * 1000); continue; }
      return { outcome: 'merge-rejected', reason: merged.message || 'GitHub rejected expected-head merge request', failed: true };
    }
    const readback = await io.getPr();
    if (readback?.number !== Number(config.prNumber) || readback?.base?.ref !== DELIVERY_BASE || readback?.merged !== true || !readback?.merged_at) {
      return { outcome: 'merge-readback-failed', reason: 'authoritative PR read-back did not confirm the expected merge into main', failed: true };
    }
    return { outcome: 'merged', merged: true, prNumber: Number(config.prNumber), expectedHeadSha: config.expectedHeadSha, mergedAt: readback.merged_at };
  }
  return { outcome: 'timeout', reason: `runtime-history delivery timed out after ${config.waitSeconds}s waiting for PR #${config.prNumber}`, failed: true };
}

function usage() { console.error('Usage: vitest-runtime-history-delivery.mjs upsert-pr|monitor-pr [options]'); }
function parseArgs(argv) {
  const command = argv.shift();
  const out = { command, repoRoot: fileURLToPath(new URL('..', import.meta.url)), repo: '', branch: DELIVERY_BRANCH, base: DELIVERY_BASE, title: 'chore(ci): refresh vitest runtime-history', bodyFile: '', prNumber: '', expectedHeadSha: '', trustedActor: '', eventSender: '', waitSeconds: DEFAULT_WAIT_SECONDS, pollSeconds: DEFAULT_POLL_SECONDS };
  const map = { '--repo': 'repo', '--branch': 'branch', '--base': 'base', '--title': 'title', '--body-file': 'bodyFile', '--pr': 'prNumber', '--expected-head-sha': 'expectedHeadSha', '--trusted-actor': 'trustedActor', '--event-sender': 'eventSender', '--wait-seconds': 'waitSeconds', '--poll-seconds': 'pollSeconds' };
  while (argv.length) {
    const key = argv.shift();
    if (key === '--snapshot') { argv.shift(); continue; }
    if (!map[key]) throw new Error(`unknown argument: ${key}`);
    const value = argv.shift() ?? '';
    out[map[key]] = key.endsWith('-seconds') ? Number(value) : value;
  }
  return out;
}

async function upsertPr(options) {
  if (options.repo !== TARGET_REPOSITORY || !options.bodyFile) throw new Error('invalid runtime-history delivery upsert arguments');
  const { owner, repo } = normalizeRepo(options.repo);
  const body = readFileSync(options.bodyFile, 'utf8');
  const pulls = runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(options.branch)}&base=${options.base}`]) ?? [];
  const reusable = selectReusableDeliveryPr(pulls);
  const args = reusable
    ? ['api', '-X', 'PATCH', `repos/${owner}/${repo}/pulls/${reusable.number}`, '-f', `title=${options.title}`, '-f', `body=${body}`]
    : ['api', `repos/${owner}/${repo}/pulls`, '-f', `title=${options.title}`, '-f', `head=${options.branch}`, '-f', `base=${options.base}`, '-f', `body=${body}`];
  const pr = runGhJson(options.repoRoot, args);
  console.log(`[PASS] runtime-history delivery PR ${reusable ? 'updated' : 'created'}: #${pr.number}`);
  console.log(JSON.stringify({ number: pr.number, url: pr.html_url, headSha: pr.head?.sha }));
}

async function monitorPr(options) {
  if (!options.repo || !options.prNumber || !options.expectedHeadSha || !options.trustedActor || !options.eventSender) throw new Error('invalid runtime-history monitor arguments');
  const result = await runDeliveryMonitor({ repo: options.repo, prNumber: Number(options.prNumber), expectedHeadSha: options.expectedHeadSha, trustedActor: options.trustedActor, eventSender: options.eventSender, waitSeconds: options.waitSeconds, pollSeconds: options.pollSeconds }, createRealIo(options));
  if (['merged', 'non-generated-head', 'close-as-obsolete'].includes(result.outcome)) { console.log(`[PASS] runtime-history delivery ${result.outcome}: ${result.reason ?? ''}`); return; }
  throw new Error(`runtime-history delivery ${result.outcome}: ${result.reason}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { usage(); return; }
  const options = parseArgs(args);
  if (options.command === 'upsert-pr') return upsertPr(options);
  if (options.command === 'monitor-pr') return monitorPr(options);
  usage(); process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
