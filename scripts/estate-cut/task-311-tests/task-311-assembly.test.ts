import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runProcessSync } from '../../kernel/subprocess.js';
import { runClaimMatrix } from './task-311-claim.test-support.js';
import {
  captureEvidenceDocument,
  installEgressTrap,
  repoRoot,
  runStaleHeadGate,
  runThreeSubjectAssembly,
  tempRoot,
  validateCompleteEvidence,
  type AcceptanceEvidence,
} from './task-311-common.test-support.js';
import { runDeliveryMatrix } from './task-311-delivery.test-support.js';
import { runScopeGate } from './task-311-scope.test-support.js';

declare global {
  interface Array<T> {
    findLast(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
  }
}

function resolveExecutable(name: string, explicit = ''): string {
  if (explicit && existsSync(explicit)) return explicit;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runProcessSync({
    command: locator,
    args: [name],
    cwd: repoRoot,
    inheritParentEnv: true,
    encoding: 'utf8',
  });
  expect(result.ok, `cannot resolve ${name}: ${result.stderr || result.error || result.outcome}`).toBe(true);
  const resolved = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? '';
  expect(resolved, `empty executable resolution for ${name}`).not.toBe('');
  return resolved;
}

function writeCommandWrapper(binDir: string, name: string, target: string): void {
  if (process.platform === 'win32') {
    writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${target}" %*\r\n`, 'utf8');
    return;
  }
  symlinkSync(target, path.join(binDir, name));
}

function installHermeticAllowedPath(root: string): string {
  const binDir = path.join(root, 'allowed-bin');
  mkdirSync(binDir, { recursive: true });
  const git = resolveExecutable('git', process.env.GIT_REAL_BINARY || process.env.GIT_SYSTEM_BINARY || '');
  const pwsh = resolveExecutable('pwsh', process.env.OPK_REAL_PWSH || '');
  writeCommandWrapper(binDir, 'node', process.execPath);
  writeCommandWrapper(binDir, 'git', git);
  writeCommandWrapper(binDir, 'pwsh', pwsh);
  if (process.platform !== 'win32') {
    writeCommandWrapper(binDir, 'sh', resolveExecutable('sh'));
    writeCommandWrapper(binDir, 'bash', resolveExecutable('bash'));
  }
  return binDir;
}

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('drives three real subjects, C1-C7 and J0-J6 with exact mutation and hermetic evidence', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const allowedPath = installHermeticAllowedPath(trapRoot);
    const trap = installEgressTrap(trapRoot);
    process.env.PATH = allowedPath;
    try {
      expect(trap.active).toBe(true);
      expect(trap.attempts()).toEqual([]);

      const assembled = await runThreeSubjectAssembly(trap);
      const claim = runClaimMatrix();
      const delivery = await runDeliveryMatrix();
      const reviewStart = runStaleHeadGate();
      expect(trap.attempts()).toEqual([]);
      const scope = runScopeGate(trap);

      const evidence: AcceptanceEvidence = {
        schemaVersion: 2,
        issue: 918,
        task: 311,
        assembly: assembled.assembly,
        capture: captureEvidenceDocument(),
        claim: claim.claim,
        delivery: delivery.delivery,
        reviewStart: reviewStart.reviewStart,
        scope: scope.scope,
        mutationEvidence: {
          AC1: assembled.mutations.AC1,
          AC2: assembled.mutations.AC2,
          AC3: claim.mutations,
          AC4: delivery.mutations,
          AC5: reviewStart.mutations,
          AC6: scope.mutations,
        },
      };

      validateCompleteEvidence(evidence);
      expect((evidence.assembly as any).binding.consumer.source).toBe('cache');
      expect((evidence.assembly as any).identity).toBe('one-pr-head-worker-chain');
      expect((evidence.claim as any).classes).toBe('C1-C7-pass');
      expect((evidence.delivery as any).classes).toBe('J0-J6-pass');
      expect((evidence.reviewStart as any).headDecision).toBe('stale-head-review-start-denied');
      expect((evidence.scope as any).result).toBe('test-only-offline-capture-backed');
      process.stdout.write(`TASK311_ACCEPTANCE_EVIDENCE=${JSON.stringify(evidence)}\n`);
    } finally {
      trap.restore();
      rmSync(trapRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
