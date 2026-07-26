#!/usr/bin/env node
/**
 * Focused Issue #990 runtime-history delivery acceptance fixtures.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DELIVERY_BRANCH,
  DELIVERY_BASE,
  DELIVERY_PATH,
  MACHINE_ADMISSION_MARKER,
  PACK_REVIEW_CONTEXT,
  PROVENANCE_CONTEXT,
  REFRESH_WORKFLOW_PATH,
  TARGET_REPOSITORY,
  evaluateRequiredChecks,
  normalizeCurrentRequiredPolicy,
  parseRefreshProvenance,
  projectPackReviewStatusHistory,
  runDeliveryMonitor,
  validateDeliveryFiles,
  validateSanctionedIdentity,
  verifyRefreshRun,
} from '../vitest-runtime-history-delivery.mjs';
import { classifyArgv } from './gh-inventory-match.mjs';

const GENERATED = '1111111111111111111111111111111111111111';
const SOURCE_MAIN = '2222222222222222222222222222222222222222';
const NEXT_HEAD = '3333333333333333333333333333333333333333';
const TRUSTED_ACTOR = 'delivery-bot';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected=${expected} actual=${actual}`);
}

// Preserve the Issue #800-grandfathered fixture subprocess shape. This remains a
// real smoke of the Git binary used by the delivery fixture rather than a dead
// baseline-only call.
function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...options,
  });
  return result;
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 });
}

function workflowRunBlock(workflow, stepName) {
  const lines = workflow.split(/\r?\n/);
  const stepLine = `      - name: ${stepName}`;
  const stepIndex = lines.indexOf(stepLine);
  if (stepIndex < 0) throw new Error(`workflow step not found: ${stepName}`);
  let runIndex = -1;
  for (let i = stepIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('      - name: ')) break;
    if (lines[i] === '        run: |') {
      runIndex = i;
      break;
    }
  }
  if (runIndex < 0) throw new Error(`workflow run block not found: ${stepName}`);
  const script = [];
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('          ')) {
      script.push(line.slice(10));
      continue;
    }
    if (line === '') {
      script.push('');
      continue;
    }
    break;
  }
  return script.join('\n');
}

function status({
  id,
  context,
  state = 'success',
  description = '',
  creator = 'operator',
  targetUrl = null,
  createdAt = new Date(Date.parse('2026-07-25T00:00:00Z') + Number(id) * 1000).toISOString(),
}) {
  return {
    id,
    context,
    state,
    description,
    created_at: createdAt,
    target_url: targetUrl,
    creator: { login: creator },
  };
}

function provenanceStatus({
  id = 1,
  state = 'success',
  runId = 9001,
  attempt = 2,
  sourceMainSha = SOURCE_MAIN,
} = {}) {
  return status({
    id,
    context: PROVENANCE_CONTEXT,
    state,
    creator: 'github-actions[bot]',
    targetUrl: `https://github.com/${TARGET_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    description: `runtime-history-provenance run=${runId} attempt=${attempt} source=${sourceMainSha}`,
  });
}

function successfulRefreshRun({
  id = 9001,
  attempt = 2,
  sourceMainSha = SOURCE_MAIN,
  statusValue = 'completed',
  conclusion = 'success',
  path = REFRESH_WORKFLOW_PATH,
  repo = TARGET_REPOSITORY,
} = {}) {
  return {
    id,
    run_attempt: attempt,
    status: statusValue,
    conclusion,
    path,
    head_sha: sourceMainSha,
    repository: { full_name: repo },
  };
}

function validPr(headSha = GENERATED) {
  return {
    number: 9901,
    state: 'open',
    merged: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'clean',
    base: { ref: DELIVERY_BASE },
    head: {
      sha: headSha,
      ref: DELIVERY_BRANCH,
      repo: { full_name: TARGET_REPOSITORY },
    },
  };
}

function livePolicy(extra = []) {
  return {
    strict: true,
    contexts: [],
    checks: [
      { context: 'Verify orchestrator-pack structure', app_id: null },
      { context: 'Contract evidence legacy list guard', app_id: null },
      { context: PACK_REVIEW_CONTEXT, app_id: null },
      ...extra.map((context) => ({ context, app_id: null })),
    ],
  };
}

function ordinaryChecks(extra = []) {
  return [
    { name: 'Verify orchestrator-pack structure', state: 'SUCCESS', bucket: 'pass' },
    { name: 'Contract evidence legacy list guard', state: 'SUCCESS', bucket: 'pass' },
    ...extra,
  ];
}

function currentPackReviewCheck(history) {
  const rows = history.filter((row) => row.context === PACK_REVIEW_CONTEXT);
  if (rows.length === 0) return null;
  const latest = [...rows].sort((a, b) => Number(a.id) - Number(b.id)).at(-1);
  const bucket = latest.state === 'success' ? 'pass' : latest.state === 'pending' ? 'pending' : 'fail';
  return { name: PACK_REVIEW_CONTEXT, state: latest.state, bucket };
}

function createIo(overrides = {}) {
  let pr = structuredClone(overrides.pr ?? validPr());
  let history = structuredClone(overrides.history ?? [provenanceStatus()]);
  let policy = structuredClone(overrides.policy ?? livePolicy());
  let checks = structuredClone(overrides.checks ?? ordinaryChecks());
  let merged = false;
  let machineWrites = 0;
  let mergeCalls = 0;
  let closeCalls = 0;
  let policyReads = 0;
  let prReads = 0;
  let statusReads = 0;
  let sleeps = 0;

  const io = {
    async getPr() {
      prReads += 1;
      return structuredClone(overrides.getPr ? await overrides.getPr({ pr, prReads, merged }) : pr);
    },
    async getFiles() {
      return structuredClone(overrides.files ?? [{ filename: DELIVERY_PATH }]);
    },
    async getChecks() {
      if (overrides.getChecks) {
        return structuredClone(await overrides.getChecks({ checks, history, machineWrites, policyReads }));
      }
      const pack = currentPackReviewCheck(history);
      return structuredClone(pack ? [...checks, pack] : checks);
    },
    async getPolicy() {
      policyReads += 1;
      return structuredClone(overrides.getPolicy ? await overrides.getPolicy({ policy, policyReads }) : policy);
    },
    async getStatusHistory() {
      statusReads += 1;
      return structuredClone(
        overrides.getStatusHistory
          ? await overrides.getStatusHistory({ history, statusReads, machineWrites })
          : history,
      );
    },
    async getActionsRun(runId) {
      return structuredClone(
        overrides.getActionsRun ? await overrides.getActionsRun({ runId }) : successfulRefreshRun({ id: runId }),
      );
    },
    async publishMachineAdmission() {
      machineWrites += 1;
      if (overrides.beforeMachineWrite) await overrides.beforeMachineWrite({ history, machineWrites });
      if (overrides.publishMachineAdmission) {
        return structuredClone(await overrides.publishMachineAdmission({ history, machineWrites }));
      }
      const row = status({
        id: 100 + history.length,
        context: PACK_REVIEW_CONTEXT,
        state: 'success',
        creator: 'github-actions[bot]',
        description: MACHINE_ADMISSION_MARKER,
      });
      history.push(row);
      return structuredClone(row);
    },
    async merge(headSha) {
      mergeCalls += 1;
      if (overrides.merge) return structuredClone(await overrides.merge({ headSha, pr, mergeCalls }));
      merged = true;
      pr = { ...pr, state: 'closed', merged: true, merged_at: '2026-07-25T01:00:00Z' };
      return { merged: true, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    },
    async closeObsolete(reason) {
      closeCalls += 1;
      if (overrides.closeObsolete) await overrides.closeObsolete({ reason });
    },
    async sleep() {
      sleeps += 1;
      if (overrides.sleep) await overrides.sleep({ sleeps });
      if (sleeps > 8) throw new Error('fixture exceeded bounded wait');
    },
  };

  return {
    io,
    state: () => ({ pr, history, policy, checks, merged, machineWrites, mergeCalls, closeCalls, policyReads, prReads, statusReads, sleeps }),
  };
}

const config = {
  repo: TARGET_REPOSITORY,
  prNumber: 9901,
  expectedHeadSha: GENERATED,
  trustedActor: TRUSTED_ACTOR,
  eventSender: TRUSTED_ACTOR,
  waitSeconds: 30,
  pollSeconds: 0,
};

function testGrandfatheredGitSmoke() {
  const result = runGit(process.cwd(), ['--version']);
  equal(result.status, 0, 'fixture Git subprocess must remain usable');
  assert(result.stdout.includes('git version'), 'fixture Git smoke must return version output');
}

function testSinglePathGate() {
  assert(validateDeliveryFiles([{ filename: DELIVERY_PATH }]).ok, 'single runtime-history path must pass');
  assert(!validateDeliveryFiles([{ filename: DELIVERY_PATH }, { filename: 'other' }]).ok, 'second path must fail');
  assert(!validateDeliveryFiles([{ filename: 'other.json' }]).ok, 'wrong path must fail');
}

function testIdentityMatrix() {
  const base = {
    repo: TARGET_REPOSITORY,
    pr: validPr(),
    expectedHeadSha: GENERATED,
    trustedActor: TRUSTED_ACTOR,
    eventSender: TRUSTED_ACTOR,
  };
  assert(validateSanctionedIdentity(base).ok, 'sanctioned identity should pass');
  equal(validateSanctionedIdentity({ ...base, repo: 'other/repo' }).outcome, 'identity-invalid', 'wrong repo');
  equal(validateSanctionedIdentity({ ...base, eventSender: 'operator' }).outcome, 'identity-invalid', 'wrong actor');
  equal(
    validateSanctionedIdentity({ ...base, pr: { ...validPr(), head: { ...validPr().head, ref: 'feature/x' } } }).outcome,
    'identity-invalid',
    'wrong branch',
  );
  equal(validateSanctionedIdentity({ ...base, pr: validPr(NEXT_HEAD) }).outcome, 'non-generated-head', 'head drift');
}

function testProvenanceMatrix() {
  const good = parseRefreshProvenance([provenanceStatus()], GENERATED);
  assert(good.ok, 'valid provenance should parse');
  equal(verifyRefreshRun(successfulRefreshRun(), good).state, 'success', 'successful run must verify');
  equal(parseRefreshProvenance([], GENERATED).outcome, 'provenance-invalid', 'missing provenance must fail');
  equal(
    parseRefreshProvenance([status({ id: 1, context: PROVENANCE_CONTEXT, description: 'bad' })], GENERATED).outcome,
    'provenance-invalid',
    'malformed provenance must fail',
  );
  equal(verifyRefreshRun(successfulRefreshRun({ id: 9002 }), good).outcome, 'provenance-invalid', 'wrong run must fail');
  equal(verifyRefreshRun(successfulRefreshRun({ attempt: 3 }), good).outcome, 'provenance-invalid', 'wrong attempt must fail');
  equal(
    verifyRefreshRun(successfulRefreshRun({ conclusion: 'failure' }), good).outcome,
    'provenance-invalid',
    'failed run must fail',
  );
}

function testSamePayloadFailedProvenanceRetryExecutesWorkflowRecovery() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-history-retry-'));
  const scriptsDir = join(root, 'scripts');
  const binDir = join(root, 'bin');
  const stateFile = join(root, 'head.txt');
  const pushAudit = join(root, 'push-audit.txt');
  const statusAudit = join(root, 'status-audit.txt');
  const reconcileOutput = join(root, 'reconcile-output.txt');
  const pushOutput = join(root, 'push-output.txt');
  const failedRunId = 9101;
  const retryRunId = 9102;
  const attempt = 1;
  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(stateFile, `${GENERATED}\n`, 'utf8');
    writeFileSync(pushAudit, '', 'utf8');
    writeFileSync(statusAudit, '', 'utf8');
    writeFileSync(reconcileOutput, '', 'utf8');
    writeFileSync(pushOutput, '', 'utf8');

    const helperSource = readFileSync(new URL('../vitest-runtime-history-delivery.mjs', import.meta.url), 'utf8');
    writeFileSync(join(scriptsDir, 'vitest-runtime-history-delivery.mjs'), helperSource, 'utf8');
    writeFileSync(join(scriptsDir, 'vitest-runtime-history.json'), '{}\n', 'utf8');

    writeExecutable(join(binDir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls-remote|fetch|add|remote) exit 0 ;;
  show) printf '%s\\n' '{}' ; exit 0 ;;
  diff) exit 0 ;;
  rev-parse)
    if [ "\${2:-}" = "HEAD" ]; then cat "\${FIXTURE_STATE}"; else printf '%s\\n' "\${FAILED_HEAD}"; fi
    exit 0
    ;;
  -c)
    printf '%s\\n' "\${NEXT_HEAD}" > "\${FIXTURE_STATE}"
    exit 0
    ;;
  push)
    printf '%s\\n' "$*" >> "\${FIXTURE_PUSH_AUDIT}"
    exit 0
    ;;
  *) echo "fake git: unhandled $*" >&2; exit 2 ;;
esac
`);
    writeExecutable(join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    writeExecutable(join(binDir, 'node'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "scripts/refresh-vitest-runtime-history.mjs" ]; then
  out=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = '--output' ]; then shift; out="$1"; break; fi
    shift
  done
  [ -n "$out" ] || { echo 'missing fake refresh output' >&2; exit 2; }
  printf '%s\\n' '{}' > "$out"
  exit 0
fi
exec "\${REAL_NODE}" "$@"
`);
    writeExecutable(join(scriptsDir, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" == *"/commits/\${FAILED_HEAD}/statuses"* ]]; then
  cat <<JSON
[{"id":1,"context":"${PROVENANCE_CONTEXT}","state":"pending","description":"runtime-history-provenance run=${failedRunId} attempt=${attempt} source=${SOURCE_MAIN}","created_at":"2026-07-25T00:00:01Z","target_url":"https://github.com/${TARGET_REPOSITORY}/actions/runs/${failedRunId}/attempts/${attempt}","creator":{"login":"github-actions[bot]"}}]
JSON
  exit 0
fi
if [[ "$joined" == *"/actions/runs/${failedRunId}"* ]]; then
  cat <<JSON
{"id":${failedRunId},"run_attempt":${attempt},"status":"completed","conclusion":"failure","path":"${REFRESH_WORKFLOW_PATH}","head_sha":"${SOURCE_MAIN}","repository":{"full_name":"${TARGET_REPOSITORY}"}}
JSON
  exit 0
fi
if [[ "$joined" == *"-X POST"*"/statuses/\${NEXT_HEAD}"* ]]; then
  printf '%s\\n' "$joined" >> "\${FIXTURE_STATUS_AUDIT}"
  printf '%s\\n' '{}'
  exit 0
fi
echo "fake gh: unhandled $joined" >&2
exit 2
`);

    const workflow = readFileSync(new URL('../../.github/workflows/vitest-runtime-history-refresh.yml', import.meta.url), 'utf8');
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      REAL_NODE: process.execPath,
      FIXTURE_STATE: stateFile,
      FIXTURE_PUSH_AUDIT: pushAudit,
      FIXTURE_STATUS_AUDIT: statusAudit,
      FAILED_HEAD: GENERATED,
      NEXT_HEAD,
      GITHUB_REPOSITORY: TARGET_REPOSITORY,
      DELIVERY_BRANCH,
      GH_TOKEN: 'fixture-token',
      GITHUB_OUTPUT: reconcileOutput,
    };

    const reconcile = spawnSync('bash', ['-c', workflowRunBlock(workflow, 'Reconcile pending delivery branch state')], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    equal(reconcile.status, 0, `same-payload reconcile block must succeed: ${reconcile.stderr}`);
    const reconcileResult = readFileSync(reconcileOutput, 'utf8');
    assert(reconcileResult.includes(`remote_sha=${GENERATED}`), 'reconcile must retain the failed remote head as lease authority');
    assert(reconcileResult.includes('should_push=true'), 'failed prior episode must keep should_push=true');
    equal(readFileSync(stateFile, 'utf8').trim(), NEXT_HEAD, 'reconcile must amend to a distinct generated head');

    const push = spawnSync('bash', ['-c', workflowRunBlock(workflow, 'Push delivery branch')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...env,
        DELIVERY_TOKEN: 'fixture-delivery-token',
        REMOTE_SHA: GENERATED,
        GITHUB_OUTPUT: pushOutput,
      },
    });
    equal(push.status, 0, `fresh generated head push block must succeed: ${push.stderr}`);
    const pushLines = readFileSync(pushAudit, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    equal(pushLines.length, 1, 'same-payload retry must push exactly one fresh generated head');
    assert(pushLines[0].includes(`refs/heads/${DELIVERY_BRANCH}:${GENERATED}`), 'retry push must retain the fetched old head as force-with-lease authority');
    assert(readFileSync(pushOutput, 'utf8').includes(`head_sha=${NEXT_HEAD}`), 'push output must bind the distinct generated head');

    const provenanceEnv = {
      ...env,
      DELIVERY_HEAD: NEXT_HEAD,
      GITHUB_RUN_ID: String(retryRunId),
      GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_SHA: SOURCE_MAIN,
      GITHUB_SERVER_URL: 'https://github.com',
    };
    const pending = spawnSync('bash', ['-c', workflowRunBlock(workflow, 'Publish pending delivery provenance')], {
      cwd: root,
      encoding: 'utf8',
      env: provenanceEnv,
    });
    equal(pending.status, 0, `fresh retry pending provenance must publish: ${pending.stderr}`);
    const complete = spawnSync('bash', ['-c', workflowRunBlock(workflow, 'Complete delivery provenance')], {
      cwd: root,
      encoding: 'utf8',
      env: provenanceEnv,
    });
    equal(complete.status, 0, `fresh retry terminal provenance must publish: ${complete.stderr}`);

    const statusLines = readFileSync(statusAudit, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    equal(statusLines.length, 2, 'fresh retry episode must emit exactly pending and success provenance writes');
    assert(statusLines[0].includes('state=pending'), 'fresh retry episode must publish pending provenance first');
    assert(statusLines[1].includes('state=success'), 'fresh retry episode must publish success provenance second');
    assert(statusLines.every((line) => line.includes(`/statuses/${NEXT_HEAD}`)), 'fresh provenance writes must bind the distinct retry head');
    assert(statusLines.every((line) => line.includes(`run=${retryRunId} attempt=${attempt} source=${SOURCE_MAIN}`)), 'fresh provenance writes must bind the retry run and source main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testStatusHistoryProjection() {
  equal(projectPackReviewStatusHistory([provenanceStatus()]).state, 'absent', 'no operator row should be absent');
  equal(
    projectPackReviewStatusHistory([
      provenanceStatus(),
      status({ id: 2, context: PACK_REVIEW_CONTEXT, state: 'success', description: 'PACK_REVIEWER clean' }),
    ]).state,
    'success',
    'operator success should satisfy',
  );
  equal(
    projectPackReviewStatusHistory([
      provenanceStatus(),
      status({ id: 2, context: PACK_REVIEW_CONTEXT, state: 'pending', description: 'PACK_REVIEWER running' }),
    ]).state,
    'pending',
    'operator pending should wait',
  );
  equal(
    projectPackReviewStatusHistory([
      provenanceStatus(),
      status({ id: 2, context: PACK_REVIEW_CONTEXT, state: 'failure', description: 'PACK_REVIEWER findings' }),
      status({ id: 3, context: PACK_REVIEW_CONTEXT, state: 'success', creator: 'github-actions[bot]', description: MACHINE_ADMISSION_MARKER }),
    ]).state,
    'veto',
    'machine success must not erase operator veto',
  );
  equal(
    projectPackReviewStatusHistory([
      status({ id: 2, context: PACK_REVIEW_CONTEXT, createdAt: '2026-07-25T00:00:10Z' }),
      status({ id: 3, context: PACK_REVIEW_CONTEXT, createdAt: '2026-07-25T00:00:09Z' }),
    ]).outcome,
    'status-history-unprovable',
    'ambiguous ordering must fail closed',
  );
  equal(
    projectPackReviewStatusHistory([
      status({ id: 2, context: PACK_REVIEW_CONTEXT, creator: 'operator', description: MACHINE_ADMISSION_MARKER }),
    ]).outcome,
    'status-history-unprovable',
    'machine marker from non-repository writer must fail closed',
  );
}

function testCurrentPolicySnapshotRegression() {
  const policy = normalizeCurrentRequiredPolicy(livePolicy(['new-required-C']));
  assert(policy.ok, 'live policy should parse');
  const decision = evaluateRequiredChecks({
    checks: ordinaryChecks([{ name: PACK_REVIEW_CONTEXT, state: 'success', bucket: 'pass' }]),
    policy,
    packReviewProjection: projectPackReviewStatusHistory([
      provenanceStatus(),
      status({ id: 2, context: PACK_REVIEW_CONTEXT, creator: 'github-actions[bot]', description: MACHINE_ADMISSION_MARKER }),
    ]),
  });
  equal(decision.outcome, 'required-context-unreported', 'snapshot A/B must not authorize missing live C');
}

function testProviderRestrictionFailsClosedWhenUnprovable() {
  const policy = normalizeCurrentRequiredPolicy({
    strict: true,
    checks: [{ context: 'Verify orchestrator-pack structure', app_id: 1234 }],
  });
  equal(policy.outcome, 'current-policy-unsupported', 'unprovable provider restriction must not be flattened away');
}

async function testHappyPathUnattended() {
  const fixture = createIo();
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'merged', 'happy path must merge');
  equal(fixture.state().machineWrites, 1, 'machine admission should publish once');
  equal(fixture.state().mergeCalls, 1, 'merge should be called once');
  assert(fixture.state().policyReads >= 2, 'policy must be re-read before merge');
  assert(fixture.state().statusReads >= 3, 'history must be re-read after publication and before merge');
}

async function testOutOfBandSuccessSkipsMachine() {
  const fixture = createIo({
    history: [
      provenanceStatus(),
      status({ id: 2, context: PACK_REVIEW_CONTEXT, state: 'success', description: 'PACK_REVIEWER clean' }),
    ],
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'merged', 'operator success can satisfy required context');
  equal(fixture.state().machineWrites, 0, 'machine admission must be skipped');
}

async function testFailurePublicationRaceBlocksMerge() {
  const fixture = createIo({
    beforeMachineWrite({ history }) {
      history.push(status({ id: 20, context: PACK_REVIEW_CONTEXT, state: 'failure', description: 'PACK_REVIEWER findings' }));
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'operator-veto-observed', 'failure race must preserve veto');
  equal(fixture.state().machineWrites, 1, 'race may contain one machine write');
  equal(fixture.state().mergeCalls, 0, 'failure race must block merge');
}

async function testErrorPublicationRaceBlocksMerge() {
  const fixture = createIo({
    beforeMachineWrite({ history }) {
      history.push(status({ id: 20, context: PACK_REVIEW_CONTEXT, state: 'error', description: 'PACK_REVIEWER error' }));
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'operator-veto-observed', 'error race must preserve veto');
  equal(fixture.state().mergeCalls, 0, 'error race must block merge');
}

async function testPendingPublicationRaceNeverRepublishes() {
  const fixture = createIo({
    beforeMachineWrite({ history }) {
      history.push(status({ id: 20, context: PACK_REVIEW_CONTEXT, state: 'pending', description: 'PACK_REVIEWER running' }));
    },
    sleep() {
      throw new Error('fixture-stop-after-pending');
    },
  });
  let stopped = false;
  try {
    await runDeliveryMonitor(config, fixture.io);
  } catch (error) {
    stopped = error.message === 'fixture-stop-after-pending';
  }
  assert(stopped, 'pending race must reach wait state');
  equal(fixture.state().machineWrites, 1, 'pending race must not republish immediately');
  equal(fixture.state().mergeCalls, 0, 'pending race must not merge');
}

async function testAmbiguousMachineWriteNeverRepublishes() {
  const fixture = createIo({
    publishMachineAdmission() {
      return status({
        id: 999,
        context: PACK_REVIEW_CONTEXT,
        state: 'success',
        creator: 'github-actions[bot]',
        description: MACHINE_ADMISSION_MARKER,
      });
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'required-context-unreported', 'unconfirmed machine admission must use the contract outcome');
  equal(fixture.state().machineWrites, 1, 'ambiguous machine write must never be blindly repeated');
  equal(fixture.state().sleeps, 1, 'ambiguous machine write gets one bounded confirmation poll');
  equal(fixture.state().mergeCalls, 0, 'unconfirmed machine admission must block merge');
}

async function testStatusHistoryReadFailureFailsClosed() {
  const fixture = createIo({ getStatusHistory() { throw new Error('pagination completeness unprovable'); } });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'status-history-unprovable', 'incomplete history must fail closed');
  equal(fixture.state().machineWrites, 0, 'history failure must block machine publication');
}

async function testMissingProvenanceFailsClosedAfterBoundedGrace() {
  const fixture = createIo({ history: [] });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'provenance-invalid', 'missing provenance must fail after bounded grace');
  equal(fixture.state().sleeps, 1, 'missing provenance gets one grace poll');
  equal(fixture.state().machineWrites, 0, 'missing provenance must not publish');
}

async function test995NonGeneratedHead() {
  const generated995 = '464b2b8b97e482f1bda8685dc528d4e97e6bfed9';
  const operatorEmpty = '5e4cb3a386856c37d94f7c3af3f64cd32e64bac7';
  const fixture = createIo({ pr: validPr(operatorEmpty) });
  const result = await runDeliveryMonitor({ ...config, expectedHeadSha: generated995 }, fixture.io);
  equal(result.outcome, 'non-generated-head', '#995 recurrence must exit unattended class');
  equal(fixture.state().machineWrites, 0, '#995 must not machine-admit');
  equal(fixture.state().mergeCalls, 0, '#995 must not merge');
  equal(fixture.state().sleeps, 0, '#995 must not wait to timeout');
}

async function testFreshEpisodeCanReenterAfter995() {
  const freshHead = '4444444444444444444444444444444444444444';
  const fixture = createIo({ pr: validPr(freshHead) });
  const result = await runDeliveryMonitor({ ...config, expectedHeadSha: freshHead }, fixture.io);
  equal(result.outcome, 'merged', 'fresh successful episode may re-enter unattended class');
}

async function testHeadDriftAtFinalBoundary() {
  const fixture = createIo({ getPr({ prReads }) { return prReads === 1 ? validPr(GENERATED) : validPr(NEXT_HEAD); } });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'non-generated-head', 'H1 proof must not authorize H2');
  equal(fixture.state().mergeCalls, 0, 'head drift must block merge');
}

async function testPolicyDriftAtFinalBoundary() {
  const fixture = createIo({ getPolicy({ policyReads }) { return policyReads === 1 ? livePolicy() : livePolicy(['new-required-C']); } });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'required-context-unreported', 'final policy read must see new required C');
  equal(fixture.state().mergeCalls, 0, 'policy drift must block merge');
}

async function testPolicyUnavailableFailsClosed() {
  const fixture = createIo({ getPolicy() { throw new Error('403'); } });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'current-policy-unavailable', 'policy lookup failure must fail closed');
  equal(fixture.state().mergeCalls, 0, 'policy lookup failure must block merge');
}

async function testOrdinaryPrIsolation() {
  const fixture = createIo({
    pr: { ...validPr(), head: { ...validPr().head, ref: 'feature/contributor' } },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'identity-invalid', 'ordinary PR must not enter special delivery path');
  equal(fixture.state().machineWrites, 0, 'ordinary PR must not receive machine admission');
  equal(fixture.state().mergeCalls, 0, 'ordinary PR must not use delivery merge path');
}

async function testMergeReadbackFailure() {
  const fixture = createIo({ merge() { return { merged: true, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; } });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'merge-readback-failed', 'mutation without authoritative merged read-back must fail');
}

async function testMergeRejectionReturnsToBoundedDecision() {
  const fixture = createIo({
    merge({ pr, mergeCalls }) {
      if (mergeCalls === 1) return { merged: false, message: 'branch protection changed' };
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = '2026-07-25T01:00:01Z';
      return { merged: true, sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'merged', 'a rejected merge must return to the bounded decision and retry only from fresh proofs');
  equal(fixture.state().mergeCalls, 2, 'fresh bounded decision may make one later merge attempt');
  assert(fixture.state().policyReads >= 4, 'merge rejection must trigger fresh policy reads before a later attempt');
  assert(fixture.state().statusReads >= 5, 'merge rejection must trigger fresh exact-head history reads before a later attempt');
}

async function testMergeRejectionThenFreshDirtyClosesObsolete() {
  const fixture = createIo({
    getPr({ prReads }) {
      if (prReads < 4) return validPr();
      return { ...validPr(), mergeable: false, mergeable_state: 'dirty' };
    },
    merge() {
      return { merged: false, message: 'branch protection changed' };
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'close-as-obsolete', 'fresh dirty state after a rejected merge must close the obsolete PR');
  equal(fixture.state().mergeCalls, 1, 'obsolete recovery must not attempt a second merge');
  equal(fixture.state().closeCalls, 1, 'obsolete recovery must perform the close side effect exactly once');
}

async function testAmbiguousMergeTransportReadbackRecognizesSuccess() {
  const fixture = createIo({
    merge({ pr }) {
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = '2026-07-25T01:00:02Z';
      throw new Error('transport reset after mutation');
    },
  });
  const result = await runDeliveryMonitor(config, fixture.io);
  equal(result.outcome, 'merged', 'authoritative read-back must recognize a merge that completed despite transport failure');
  equal(fixture.state().mergeCalls, 1, 'ambiguous transport success must not trigger a duplicate merge mutation');
}

function testSourceContracts() {
  const source = readFileSync(new URL('../vitest-runtime-history-delivery.mjs', import.meta.url), 'utf8');
  assert(source.includes('`sha=${headSha}`'), 'existing expected-head merge protection must remain');
  assert(!source.includes('PACK_REVIEWER'), 'generated helper must not invoke PACK_REVIEWER');
  assert(!source.includes('requiredCheckNamesFromSnapshot'), 'snapshot must not remain readiness authority');

  const refreshWorkflow = readFileSync(new URL('../../.github/workflows/vitest-runtime-history-refresh.yml', import.meta.url), 'utf8');
  assert(refreshWorkflow.includes(PROVENANCE_CONTEXT), 'refresh workflow must emit provenance');
  assert(refreshWorkflow.includes('actions: read'), 'same-payload provenance recovery must be able to verify the bound Actions run');
  assert(refreshWorkflow.includes('parseRefreshProvenance'), 'same-payload recovery must reuse the canonical provenance parser');
  assert(refreshWorkflow.includes('verifyRefreshRun'), 'same-payload recovery must verify the prior refresh episode before reusing its head');
  assert(refreshWorkflow.includes('matching remote payload lacks successful exact-head provenance; regenerating delivery head'), 'failed provenance must regenerate the generated head instead of deadlocking the PR');
  assert(refreshWorkflow.includes('commit --amend --no-edit'), 'invalid-provenance recovery must be able to regenerate a distinct delivery head without an extra empty commit');
  assert(!refreshWorkflow.includes('PACK_REVIEWER'), 'refresh workflow must not invoke PACK_REVIEWER');

  const deliveryWorkflow = readFileSync(new URL('../../.github/workflows/vitest-runtime-history-delivery.yml', import.meta.url), 'utf8');
  assert(deliveryWorkflow.includes('./scripts/gh api user --jq .login'), 'trusted actor resolution must remain');
  assert(deliveryWorkflow.includes('--trusted-actor "${{ steps.delivery_actor.outputs.trusted_actor }}"'), 'monitor must receive trusted actor');
  assert(deliveryWorkflow.includes('--event-sender "${{ github.event.sender.login }}"'), 'monitor must receive event sender');
}

function testNarrowGithubReadInventory() {
  const policy = classifyArgv(['api', 'repos/chetwerikoff/orchestrator-pack/branches/main/protection/required_status_checks']).route;
  equal(policy?.id, 'runtime-history-main-required-status-checks', 'policy read must be inventory routed');

  const run = classifyArgv(['api', 'repos/chetwerikoff/orchestrator-pack/actions/runs/30142129797']).route;
  equal(run?.id, 'runtime-history-actions-run', 'actions run read must be inventory routed');
  equal(run?.runId, 30142129797, 'actions run id must stay exact');

  const history = classifyArgv(['api', `repos/chetwerikoff/orchestrator-pack/commits/${GENERATED}/statuses`]).route;
  equal(history?.id, 'runtime-history-status-history', 'exact-head history must be inventory routed');
  equal(history?.headSha, GENERATED, 'status-history route must bind exact head');

  assert(classifyArgv(['api', 'repos/chetwerikoff/orchestrator-pack/actions/runs']).route === null, 'generic actions API must remain unclassified');
  assert(classifyArgv(['api', 'repos/chetwerikoff/orchestrator-pack/commits/not-a-sha/statuses']).route === null, 'invalid status-history near miss must remain unclassified');
  assert(classifyArgv(['api', 'repos/other/repo/branches/main/protection/required_status_checks']).route === null, 'policy route must not generalize to another repo');
  assert(classifyArgv(['api', 'rate_limit']).route === null, 'unrelated gh api reads must remain outside expansion');
}

async function main() {
  const tests = [
    testGrandfatheredGitSmoke,
    testSinglePathGate,
    testIdentityMatrix,
    testProvenanceMatrix,
    testSamePayloadFailedProvenanceRetryExecutesWorkflowRecovery,
    testStatusHistoryProjection,
    testCurrentPolicySnapshotRegression,
    testProviderRestrictionFailsClosedWhenUnprovable,
    testHappyPathUnattended,
    testOutOfBandSuccessSkipsMachine,
    testFailurePublicationRaceBlocksMerge,
    testErrorPublicationRaceBlocksMerge,
    testPendingPublicationRaceNeverRepublishes,
    testAmbiguousMachineWriteNeverRepublishes,
    testStatusHistoryReadFailureFailsClosed,
    testMissingProvenanceFailsClosedAfterBoundedGrace,
    test995NonGeneratedHead,
    testFreshEpisodeCanReenterAfter995,
    testHeadDriftAtFinalBoundary,
    testPolicyDriftAtFinalBoundary,
    testPolicyUnavailableFailsClosed,
    testOrdinaryPrIsolation,
    testMergeReadbackFailure,
    testMergeRejectionReturnsToBoundedDecision,
    testMergeRejectionThenFreshDirtyClosesObsolete,
    testAmbiguousMergeTransportReadbackRecognizesSuccess,
    testSourceContracts,
    testNarrowGithubReadInventory,
  ];

  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(`${test.name}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('[FAIL] runtime-history delivery fixtures:');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }

  console.log(`[PASS] runtime-history delivery fixtures OK (${tests.length} cases)`);
}

await main();
