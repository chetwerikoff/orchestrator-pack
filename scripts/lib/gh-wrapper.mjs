#!/usr/bin/env node
/**
 * Pack gh wrapper — known inventory reads always REST; unknown argv passthrough (Issue #431).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyArgv } from './gh-inventory-match.mjs';
import { exitCodeForPrChecks } from './gh-pr-checks.mjs';
import { resolveRealGhBinary } from './gh-resolve-real-binary.mjs';
import { tryGraphqlDegradedPassthrough } from './gh-graphql-degraded.mjs';
import { executeRestRoute } from './gh-rest-routes.mjs';
import { consumeGhApiRateLimitHeaders, REST_ERROR_MARKER } from './gh-repo-resolve.mjs';

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

function passthrough(argv) {
  const realGh = resolveRealGhBinary();
  if (tryGraphqlDegradedPassthrough(argv, realGh)) {
    return;
  }
  const result = spawnSync(realGh, argv, {
    cwd: process.cwd(),
    env: { ...process.env, GH_WRAPPER_ACTIVE: '1' },
    stdio: 'inherit',
  });
  const status = result.status ?? 1;
  writeWrapperAudit('complete', buildAuditFields(argv, {
    kind: 'passthrough',
    route: 'passthrough',
    status,
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
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...allFields,
    })}\n`);
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
    passthrough(argv);
    return;
  }

  const realGh = resolveRealGhBinary();
  try {
    const result = executeRestRoute(route.id, { realGh, parsed, route, cwd: process.cwd() });
    const out = formatStdout(result, parsed, route);
    process.stdout.write(out);
    const status = route.id === 'pr-checks' ? exitCodeForPrChecks(result) : 0;
    writeWrapperAudit('complete', buildAuditFields(argv, {
      kind: 'rest',
      route: route.id,
      status,
      rateLimit: consumeGhApiRateLimitHeaders(),
    }, parsed));
    if (route.id === 'pr-checks') {
      process.exit(status);
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeWrapperAudit('complete', buildAuditFields(argv, {
      kind: 'rest',
      route: route.id,
      status: 1,
      rateLimit: consumeGhApiRateLimitHeaders(),
    }, parsed));
    if (message.startsWith('no checks reported')) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    failRest(message);
  }
}

main();
