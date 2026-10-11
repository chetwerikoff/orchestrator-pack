#!/usr/bin/env node
/**
 * Pack gh wrapper — known inventory reads always REST; unknown argv passthrough (Issue #431).
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appendAuditJsonlLine, resolveAuditJsonlPolicy } from './audit-jsonl-retention.mjs';
import { classifyArgv, isUnsupportedHighLevelRead } from './gh-inventory-match.mjs';
import { exitCodeForPrChecks } from './gh-pr-checks.mjs';
import { resolveRealGhBinary } from './gh-resolve-real-binary.mjs';
import { tryGraphqlDegradedPassthrough } from './gh-graphql-degraded.mjs';
import { executeRestRoute } from './gh-rest-routes.mjs';
import { consumeGhApiRateLimitHeaders, pickJsonFields, REST_ERROR_MARKER } from './gh-repo-resolve.mjs';
import {
  acquireGithubGovernorAdmission,
  formatGovernorDenialMessage,
  GOVERNOR_DENIAL_EXIT_CODE,
  isGovernorEnabled,
  resolveCallerLane,
} from './gh-governor.mjs';
import {
  isGhPrCreateArgv,
  tryPushRegisterFromPrCreate,
} from '../../docs/pr-session-binding-cache.mjs';

function formatStdout(result, parsed, route) {
  if (route?.id === 'pr-diff-name-only') {
    return `${result.join('\n')}\n`;
  }
  if (route?.id === 'run-view-log-failed' || route?.id === 'actions-job-log') {
    return result.endsWith('\n') ? result : `${result}\n`;
  }

  if (parsed.jq && (
    parsed.jq === '.baseRefName'
    || parsed.jq === '.body'
    || parsed.jq === '.headRefOid'
    || parsed.jq === '.nameWithOwner'
  )) {
    if (typeof result === 'string' || typeof result === 'number') {
      return `${result}\n`;
    }
  }

  if (parsed.jq === '.[0].number') {
    if (result === null || result === undefined) {
      return 'null\n';
    }
    return `${JSON.stringify(result)}\n`;
  }

  if (parsed.jq === '{number: .number, body: .body}' || parsed.jq === "{number: .number, body: .body}") {
    return `${JSON.stringify(result)}\n`;
  }

  if (parsed.jsonFields || route) {
    return `${JSON.stringify(result)}\n`;
  }

  return `${String(result)}\n`;
}

function withGovernorRelease(admission, fields = {}) {
  if (!admission || admission.skipped || typeof admission.release !== 'function') {
    return;
  }
  admission.release(fields);
}

function denyGovernorAdmission(admission, argv, parsed = {}) {
  const message = formatGovernorDenialMessage(admission);
  writeWrapperAudit('governor-deny', buildAuditFields(argv, {
    kind: 'governor',
    lane: admission.lane,
    reason: admission.reason,
    ...admission.audit,
  }, parsed));
  process.stderr.write(`${message}\n`);
  process.exit(GOVERNOR_DENIAL_EXIT_CODE);
}

function beginGovernorAdmission(argv, realGh) {
  if (!isGovernorEnabled()) {
    return { admitted: true, skipped: true, release: () => {} };
  }
  const admission = acquireGithubGovernorAdmission({ argv, realGh, env: process.env });
  if (!admission.admitted) {
    return admission;
  }
  writeWrapperAudit('governor-admit', buildAuditFields(argv, {
    kind: 'governor',
    lane: admission.lane ?? resolveCallerLane(process.env, argv),
    emergency: Boolean(admission.emergency),
    ...admission.audit,
  }));
  return admission;
}

const PASSTHROUGH_STDERR_CAPTURE_MAX = 64 * 1024;

function runNativePassthrough(realGh, argv, captureStderrForGovernor, captureStdoutForPushRegister = false) {
  const spawnOptions = {
    cwd: process.cwd(),
    env: { ...process.env, GH_WRAPPER_ACTIVE: '1' },
  };
  if (!captureStderrForGovernor && !captureStdoutForPushRegister) {
    const result = spawnSync(realGh, argv, { ...spawnOptions, stdio: 'inherit' });
    return Promise.resolve({ status: result.status ?? 1, stderr: '', stdout: '' });
  }

  return new Promise((resolve) => {
    const stderrParts = [];
    const stdoutParts = [];
    const child = spawn(realGh, argv, {
      ...spawnOptions,
      stdio: ['inherit', captureStdoutForPushRegister ? 'pipe' : 'inherit', 'pipe'],
    });
    if (captureStdoutForPushRegister && child.stdout) {
      child.stdout.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        process.stdout.write(buf);
        stdoutParts.push(buf);
      });
    }
    child.stderr.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      process.stderr.write(buf);
      stderrParts.push(buf);
      const combined = Buffer.concat(stderrParts);
      if (combined.length > PASSTHROUGH_STDERR_CAPTURE_MAX) {
        stderrParts.length = 0;
        stderrParts.push(combined.subarray(combined.length - PASSTHROUGH_STDERR_CAPTURE_MAX));
      }
    });
    const finish = (status) => {
      const stderr = stderrParts.length > 0
        ? Buffer.concat(stderrParts).toString('utf8')
        : '';
      const stdout = stdoutParts.length > 0
        ? Buffer.concat(stdoutParts).toString('utf8')
        : '';
      resolve({ status, stderr, stdout });
    };
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', () => finish(1));
  });
}

async function passthrough(argv) {
  const realGh = resolveRealGhBinary();
  const admission = beginGovernorAdmission(argv, realGh);
  if (!admission.admitted) {
    denyGovernorAdmission(admission, argv);
    return;
  }
  if (tryGraphqlDegradedPassthrough(argv, realGh, {
    partitionKey: admission.partitionKey,
    onComplete: (fields = {}) => {
      withGovernorRelease(admission, {
        exitCode: fields.status ?? 0,
        headers: fields.rateLimit,
        stderr: fields.stderr,
        stdout: fields.stdout,
      });
      writeWrapperAudit('complete', buildAuditFields(argv, {
        kind: 'passthrough',
        route: 'graphql-degraded',
        ...fields,
      }));
    },
  })) {
    return;
  }
  const captureStdoutForPushRegister = isGhPrCreateArgv(argv);
  const captureStderrForGovernor = (isGovernorEnabled() && !admission.skipped) || captureStdoutForPushRegister;
  const { status, stderr, stdout } = await runNativePassthrough(
    realGh,
    argv,
    captureStderrForGovernor,
    captureStdoutForPushRegister,
  );
  const rateLimit = consumeGhApiRateLimitHeaders();
  withGovernorRelease(admission, {
    exitCode: status,
    stderr,
    headers: rateLimit,
  });
  if (captureStdoutForPushRegister) {
    let pushRegister;
    try {
      pushRegister = tryPushRegisterFromPrCreate({
        argv,
        status,
        stdout,
        stderr,
        env: process.env,
        cwd: process.cwd(),
      });
    } catch (error) {
      pushRegister = {
        registered: false,
        reason: 'push_register_unhandled_error',
        diagnostic: String(error?.message ?? error),
      };
    }
    writeWrapperAudit('push-register', buildAuditFields(argv, {
      kind: 'push-register',
      registered: pushRegister.registered,
      reason: pushRegister.reason,
      diagnostic: pushRegister.diagnostic,
    }));
  }
  writeWrapperAudit('complete', buildAuditFields(argv, {
    kind: 'passthrough',
    route: 'passthrough',
    status,
    rateLimit,
  }));
  process.exit(status);
}

function failRest(message) {
  const text = message.startsWith(REST_ERROR_MARKER) ? message : `${REST_ERROR_MARKER}: ${message}`;
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

const FULL_PR_CHECKS_JSON_FIELDS = 'name,state,bucket,link,startedAt,completedAt,workflow,description';

function positiveSafeDecimalId(value) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeRepositoryAdvice(parsed) {
  const repo = String(parsed.repo ?? '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) ? ' --repo ' + repo : '';
}

function highLevelReadRefusal(parsed) {
  const [root, sub] = parsed.subcommand;
  const flags = Object.keys(parsed.flags);
  const required = flags.includes('--required');
  const watch = flags.includes('--watch') || flags.includes('-w');
  const semanticWarning = (required || watch)
    ? ' An unfiltered one-shot read is NON-EQUIVALENT: it cannot reproduce '
      + (required ? '--required required-only filtering' : '')
      + (required && watch ? ' or ' : '')
      + (watch ? '--watch polling' : '') + '.'
    : '';

  if (root === 'pr' && sub === 'checks') {
    const prId = parsed.positionals.length === 1
      ? positiveSafeDecimalId(parsed.positionals[0]) : null;
    const missing = prId === null
      ? ' Supply exactly one positive, decimal-only, safe-integer PR ID (no extra positionals).'
      : '';
    const json = !parsed.jsonFields?.length
      ? ' The REST checks route requires --json with supported check fields.'
      : ' Only inventoried --json fields and no unsupported flags/jq are accepted.';
    const unsupported = flags.length ? ' Unsupported option(s): ' + flags.join(', ') + '.' : '';
    const advice = prId === null
      ? ' No runnable PR-checks command can be formed until the real PR ID is known.'
      : ' Closest inventory-authorized snapshot: `gh pr checks ' + prId
        + safeRepositoryAdvice(parsed) + ' --json ' + FULL_PR_CHECKS_JSON_FIELDS + '`';
    return 'uncovered pr checks read form.' + missing + json + unsupported
      + semanticWarning + advice;
  }

  if (root === 'run' && parsed.positionals[0] === 'view') {
    const runId = parsed.positionals.length === 2
      ? positiveSafeDecimalId(parsed.positionals[1]) : null;
    const missing = runId === null
      ? ' A real positive, decimal-only, safe-integer RUN_ID is required; no extra positionals.'
      : '';
    const logFlag = parsed.flags['--log-failed'];
    const incomplete = (logFlag !== true && logFlag !== 'true')
      ? ' The complete failed-run read requires --log-failed.'
      : '';
    const unsupported = flags.filter((flag) => flag !== '--log-failed');
    const extra = unsupported.length ? ' Unsupported option(s): ' + unsupported.join(', ') + '.' : '';
    const advice = runId === null
      ? ' A known PR may have a checks link pointing to an actual Actions run ID; inspect the link field of the inventoried PR checks snapshot when that PR ID is known. Do not invent a run or job ID. A single known-job log is only partial run evidence.'
      : ' Closest inventory-authorized whole-failed-run read: `gh run view ' + runId
        + safeRepositoryAdvice(parsed) + ' --log-failed`. A single known-job log would be partial evidence.';
    return 'uncovered run view read form.' + missing + incomplete + extra
      + semanticWarning + advice;
  }
  return 'uncovered high-level read form';
}

function formatAuditValue(value) {
  return String(value).replace(/\s+/g, '_');
}

function auditFilePath() {
  if (process.env.GH_WRAPPER_AUDIT_FILE) {
    return process.env.GH_WRAPPER_AUDIT_FILE;
  }
  if (process.env.OPK_SIDE_PROCESS_STATE_DIR) {
    return join(process.env.OPK_SIDE_PROCESS_STATE_DIR, 'gh-wrapper-audit.jsonl');
  }
  if (process.env.GH_WRAPPER_AUDIT === '1') {
    const stateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || process.cwd(), '.local', 'state');
    return join(stateHome, 'orchestrator-pack', 'gh-wrapper-audit.jsonl');
  }
  return null;
}

function argvHash(argv) {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex').slice(0, 16);
}

function extractPrAndHead(argv, parsed = {}) {
  const fields = {};
  if (Number.isInteger(parsed.prNumber)) {
    fields.prNumber = parsed.prNumber;
  }
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === 'pr' && (argv[i + 1] === 'view' || argv[i + 1] === 'checks' || argv[i + 1] === 'diff'))
      && /^\d+$/.test(String(argv[i + 2] ?? ''))) {
      fields.prNumber = Number(argv[i + 2]);
    }
    if (argv[i] === '--head' && argv[i + 1]) {
      fields.headRef = String(argv[i + 1]);
    }
  }
  return fields;
}

function buildAuditFields(argv, fields = {}, parsed = {}) {
  return {
    command: argv[0] ?? '',
    subcommand: argv[1] ?? '',
    argvHash: argvHash(argv),
    ...extractPrAndHead(argv, parsed),
    ...fields,
  };
}

function rateLimitKind(headers = {}) {
  if (headers['retry-after']) {
    return 'secondary_or_abuse';
  }
  if (headers['x-ratelimit-remaining'] === '0') {
    return 'primary';
  }
  if (Object.keys(headers).length > 0) {
    return 'observed';
  }
  return undefined;
}

function writeWrapperAudit(event, fields = {}) {
  const childId = process.env.OPK_SIDE_PROCESS_CHILD_ID;
  const rateLimit = fields.rateLimit && typeof fields.rateLimit === 'object' ? fields.rateLimit : {};
  const allFields = {
    ...(childId ? { child: childId } : {}),
    ...fields,
    ...(Object.keys(rateLimit).length > 0 ? { rateLimitKind: rateLimitKind(rateLimit) } : {}),
  };
  const filePath = auditFilePath();
  if (filePath) {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        event,
        ...allFields,
      });
      const logMaintenance = (kind, fields = {}) => {
        if (process.env.GH_WRAPPER_AUDIT !== '1') {
          return;
        }
        const suffix = Object.entries(fields)
          .map(([key, value]) => `${key}=${formatAuditValue(value)}`)
          .join(' ');
        process.stderr.write(`gh-wrapper-audit-retention: ${kind}${suffix ? ` ${suffix}` : ''}\n`);
      };
      appendAuditJsonlLine(filePath, line, {
        streamId: 'gh-wrapper',
        log: logMaintenance,
      });
    } catch (err) {
      if (process.env.GH_WRAPPER_AUDIT === '1') {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`gh-wrapper-audit: write_failed reason=${formatAuditValue(reason)}\n`);
      }
    }
  }
  if (process.env.GH_WRAPPER_AUDIT !== '1') {
    return;
  }
  const suffix = Object.entries(allFields)
    .filter(([, value]) => value !== undefined && value !== null)
    .filter(([key]) => key !== 'rateLimit')
    .map(([key, value]) => `${key}=${formatAuditValue(value)}`)
    .join(' ');
  process.stderr.write(`gh-wrapper-audit: ${event}${suffix ? ` ${suffix}` : ''}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  writeWrapperAudit('entry', buildAuditFields(argv));

  const targetRepository = String(process.env.OPK_TARGET_REPOSITORY ?? '').trim();
  const targetDefaultBranch = String(process.env.OPK_TARGET_DEFAULT_BRANCH ?? '').trim();
  const targetAuthorization = targetRepository && targetDefaultBranch
    ? { repository: targetRepository, defaultBranch: targetDefaultBranch }
    : undefined;
  const { parsed, route } = classifyArgv(
    argv,
    targetAuthorization ? { targetAuthorization } : {},
  );
  if (!route) {
    if (isUnsupportedHighLevelRead(parsed)) {
      failRest(highLevelReadRefusal(parsed));
      return;
    }
    passthrough(argv).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
    return;
  }

  const realGh = resolveRealGhBinary();
  const admission = beginGovernorAdmission(argv, realGh);
  if (!admission.admitted) {
    denyGovernorAdmission(admission, argv, parsed);
    return;
  }
  try {
    const result = executeRestRoute(route.id, { realGh, parsed, route, cwd: process.cwd() });
    if (route.id === 'pr-checks' && (!Array.isArray(result) || result.length === 0)) {
      throw new Error('PR checks returned no check rows; no complete successful checks result can be asserted');
    }
    if ((route.id === 'actions-job-log' || route.id === 'run-view-log-failed')
      && (typeof result !== 'string' || !result.trim())) {
      throw new Error('Actions log read returned no text; do not treat an empty log as complete evidence');
    }
    const outputResult = route.id === 'pr-checks' && parsed.jsonFields
      ? result.map((check) => pickJsonFields(check, parsed.jsonFields))
      : result;
    const out = formatStdout(outputResult, parsed, route);
    process.stdout.write(out);
    const status = route.id === 'pr-checks' ? exitCodeForPrChecks(result) : 0;
    const rateLimit = consumeGhApiRateLimitHeaders();
    withGovernorRelease(admission, { exitCode: status, headers: rateLimit });
    writeWrapperAudit('complete', buildAuditFields(argv, {
      kind: 'rest',
      route: route.id,
      status,
      rateLimit,
    }, parsed));
    if (route.id === 'pr-checks') {
      process.exit(status);
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rateLimit = consumeGhApiRateLimitHeaders();
    withGovernorRelease(admission, { exitCode: 1, stderr: message, headers: rateLimit });
    writeWrapperAudit('complete', buildAuditFields(argv, {
      kind: 'rest',
      route: route.id,
      status: 1,
      rateLimit,
    }, parsed));
    failRest(message);
  }
}

main();
