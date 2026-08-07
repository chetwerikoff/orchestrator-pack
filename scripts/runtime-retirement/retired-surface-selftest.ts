#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import assert from 'node:assert/strict';
import { scanRetiredRuntimeSurfaces } from './retired-surface-guard.ts';
const result = scanRetiredRuntimeSurfaces({ repoRoot: process.cwd() });
assert.equal(result.violations.length, 0, JSON.stringify(result.violations.slice(0, 50), null, 2));
process.stdout.write(`${JSON.stringify({ ok: true, scannedFileCount: result.scannedFileCount })}\n`);
