#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { evaluateSkillPointerDrift, writeSkillPointers } from './skill-pointers.ts';

const command = process.argv[2] ?? 'check';
const repoRoot = process.cwd();
if (command === 'generate') {
  const count = writeSkillPointers(repoRoot);
  process.stdout.write(`[PASS] Generated ${count} Claude skill pointer file(s) from Cursor canonical skills.\n`);
} else if (command === 'check') {
  const failures = evaluateSkillPointerDrift(repoRoot);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`[FAIL] ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('[PASS] Cursor canonical skills and generated Claude pointers are in exact sync.\n');
  }
} else {
  process.stderr.write('usage: generate-skill-pointers.ts [check|generate]\n');
  process.exitCode = 2;
}
