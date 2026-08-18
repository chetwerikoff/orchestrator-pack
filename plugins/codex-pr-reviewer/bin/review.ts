#!/usr/bin/env -S node --experimental-strip-types

import '../../../scripts/toolchain/native-entrypoint-preflight.ts';
import { runProcess } from '../../../scripts/kernel/subprocess.ts';
import { runReviewCli } from '../lib/review_cli.ts';

const HARNESS_REENTRY_ENV = 'OPK_REVIEW_TS_HARNESS_REENTRY';

if (process.env.OPK_VITEST_HARNESS === '1' && process.env[HARNESS_REENTRY_ENV] !== '1') {
  const delegated = await runProcess({
    command: 'node',
    args: [process.argv[1]!, ...process.argv.slice(2)],
    cwd: process.cwd(),
    inheritParentEnv: true,
    env: { [HARNESS_REENTRY_ENV]: '1' },
    allowEmptyStdout: true,
  });
  if (delegated.stdout) process.stdout.write(delegated.stdout);
  if (delegated.stderr) process.stderr.write(delegated.stderr);
  process.exitCode = delegated.ok ? 0 : (delegated.exitCode ?? 1);
} else {
  runReviewCli(process.argv.slice(2));
}
