#!/usr/bin/env -S node --experimental-strip-types

import '../../../scripts/toolchain/native-entrypoint-preflight.ts';
import { spawnSync } from 'node:child_process';
import { runReviewCli } from '../lib/review_cli.ts';

const HARNESS_REENTRY_ENV = 'OPK_REVIEW_TS_HARNESS_REENTRY';

if (process.env.OPK_VITEST_HARNESS === '1' && process.env[HARNESS_REENTRY_ENV] !== '1') {
  const delegated = spawnSync('node', [process.argv[1]!, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, [HARNESS_REENTRY_ENV]: '1' },
    encoding: 'utf8',
  });
  if (delegated.stdout) process.stdout.write(delegated.stdout);
  if (delegated.stderr) process.stderr.write(delegated.stderr);
  if (delegated.error) throw delegated.error;
  process.exitCode = delegated.status ?? 1;
} else {
  runReviewCli(process.argv.slice(2));
}
