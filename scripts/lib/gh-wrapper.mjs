#!/usr/bin/env node
/**
 * Pack gh wrapper — known inventory reads always REST; unknown argv passthrough (Issue #431).
 */
import { spawnSync } from 'node:child_process';
import { classifyArgv } from './gh-inventory-match.mjs';
import { exitCodeForPrChecks } from './gh-pr-checks.mjs';
import { resolveRealGhBinary } from './gh-resolve-real-binary.mjs';
import { tryGraphqlDegradedPassthrough } from './gh-graphql-degraded.mjs';
import { executeRestRoute } from './gh-rest-routes.mjs';
import { REST_ERROR_MARKER } from './gh-repo-resolve.mjs';

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
  writeWrapperAudit('complete', { kind: 'passthrough', route: 'passthrough', status });
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

function writeWrapperAudit(event, fields = {}) {
  if (process.env.GH_WRAPPER_AUDIT !== '1') {
    return;
  }
  const childId = process.env.AO_SIDE_PROCESS_CHILD_ID;
  const allFields = childId ? { child: childId, ...fields } : fields;
  const suffix = Object.entries(allFields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatAuditValue(value)}`)
    .join(' ');
  process.stderr.write(`gh-wrapper-audit: ${event}${suffix ? ` ${suffix}` : ''}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  writeWrapperAudit('entry');

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
    writeWrapperAudit('complete', { kind: 'rest', route: route.id, status });
    if (route.id === 'pr-checks') {
      process.exit(status);
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeWrapperAudit('complete', { kind: 'rest', route: route.id, status: 1 });
    if (message.startsWith('no checks reported')) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    failRest(message);
  }
}

main();
