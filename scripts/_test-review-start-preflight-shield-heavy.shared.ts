import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateOrchestratorTurnGate } from '../docs/orchestrator-claimed-review-run.mjs';
import { functionBody, psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  claimHelperPath,
  driftHeadB,
  fakeGhPath,
  ghPrChecksPath,
  listShieldAuditRecords,
  runScopedPreflight,
  shieldHelperPath,
  snapshotPath,
  stableHead,
} from './_test-review-start-preflight-shield-fixture.js';

export {
  claimHelperPath,
  describe,
  driftHeadB,
  evaluateOrchestratorTurnGate,
  existsSync,
  expect,
  fakeGhPath,
  functionBody,
  ghPrChecksPath,
  it,
  listShieldAuditRecords,
  mkdtempSync,
  path,
  psString,
  readFileSync,
  readdirSync,
  repoRoot,
  rmSync,
  runPwsh,
  runScopedPreflight,
  shieldHelperPath,
  snapshotPath,
  stableHead,
  tmpdir,
  vi,
  writeFileSync,
};
