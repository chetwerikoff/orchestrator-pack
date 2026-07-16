#!/usr/bin/env node
/**
 * Pack gh wrapper — known inventory reads always REST; unknown argv passthrough (Issue #431).
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appendAuditJsonlLine, resolveAuditJsonlPolicy } from './audit-jsonl-retention.mjs';
import { classifyArgv } from './gh-inventory-match.mjs';
import { exitCodeForPrChecks } from './gh-pr-checks.mjs';
import { resolveRealGhBinary } from './gh-resolve-real-binary.mjs';
import { tryGraphqlDegradedPassthrough } from './gh-graphql-degraded.mjs';
import { executeRestRoute } from './gh-rest-routes.mjs';
import { consumeGhApiRateLimitHeaders, REST_ERROR_MARKER } from './gh-repo-resolve.mjs';
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

  if (parsed.jq && (parsed.jq === '.baseRefName' || parsed.jq === '.body' || parsed.jq === '.nameWithOwner')) {
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

function formatAuditValue(value) {
  return String(value).replace(/\s+/g, '_');
}

function auditFilePath() {
  if (process.env.GH_WRAPPER_AUDIT_FILE) {
    return process.env.GH_WRAPPER_AUDIT_FILE;
  }
  if (process.env.AO_SIDE_PROCESS_STATE_DIR) {
    return join(process.env.AO_SIDE_PROCESS_STATE_DIR, 'gh-wrapper-audit.jsonl');
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
  const childId = process.env.AO_SIDE_PROCESS_CHILD_ID;
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

  const { parsed, route } = classifyArgv(argv);
  if (!route) {
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
    const out = formatStdout(result, parsed, route);
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
