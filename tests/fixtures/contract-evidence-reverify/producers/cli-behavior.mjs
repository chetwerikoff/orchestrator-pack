#!/usr/bin/env node
/** Fixture producer: exits with configured status and optional JSON stdout. */
const exitCode = Number(process.env.REVERIFY_EXIT_CODE ?? '0');
const body = process.env.REVERIFY_BODY ?? '';
if (body) {
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
}
process.exit(Number.isFinite(exitCode) ? exitCode : 0);
