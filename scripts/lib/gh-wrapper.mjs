#!/usr/bin/env node
/**
 * Pack gh wrapper — known inventory reads always REST; unknown argv passthrough (Issue #431).
 */
import { spawnSync } from 'node:child_process';
import { classifyArgv } from './gh-inventory-match.mjs';
import { resolveRealGhBinary, WRAPPER_PATH } from './gh-resolve-real-binary.mjs';
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
  const result = spawnSync(realGh, argv, {
    cwd: process.cwd(),
    env: { ...process.env, GH_WRAPPER_ACTIVE: '1' },
    encoding: 'buffer',
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  if (result.stdout?.length) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr?.length) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}

function failRest(message) {
  const text = message.startsWith(REST_ERROR_MARKER) ? message : `${REST_ERROR_MARKER}: ${message}`;
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (process.env.GH_WRAPPER_AUDIT === '1') {
    process.stderr.write('gh-wrapper-audit: entry\n');
  }

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
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('no checks reported')) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    failRest(message);
  }
}

main();
