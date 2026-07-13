/**
 * Never-skipped floor gates for tier-gate receipt (#576 AC3).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  checkPositiveOutcome,
  parseBehaviorKind,
} from '../draft-discipline.mjs';
import { checkContractEvidence } from '../contract-evidence-validator.mjs';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';

export interface TierGateFloorOptions {
  repoRoot?: string;
  draftPath?: string;
}

export function checkWorkerSafetyFloor(draftText: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!/^##\s+Goal\b/m.test(draftText)) {
    errors.push('worker-safety floor: missing ## Goal section');
  }
  if (!/```denylist\s*\n[\s\S]*?```/m.test(draftText)) {
    errors.push('worker-safety floor: missing ```denylist fence');
  }
  if (!/```allowed-roots\s*\n[\s\S]*?```/m.test(draftText)) {
    errors.push('worker-safety floor: missing ```allowed-roots fence');
  }
  if (!/^##\s+Acceptance criteria\b/m.test(draftText)) {
    errors.push('worker-safety floor: missing ## Acceptance criteria section');
  }
  if (!/^##\s+Verification\b/m.test(draftText)) {
    errors.push('worker-safety floor: missing ## Verification section');
  }
  return { ok: errors.length === 0, errors };
}

export function resolveReviewArtifacts(draftPath: string, repoRoot: string) {
  const stem = basename(draftPath.replace(/\\/g, '/'), '.md');
  const capturesDir = join(repoRoot, 'docs/issues_drafts/.review', stem);
  const ledgerPath = join(capturesDir, 'finding-disposition-ledger.json');
  const captureFiles = existsSync(capturesDir)
    ? readdirSync(capturesDir)
      .filter((name) => name.endsWith('.capture.txt'))
      .sort()
      .map((name) => join(capturesDir, name))
    : [];
  return { capturesDir, ledgerPath, captureFiles };
}

export function checkBehaviorKindFloor(draftText: string): { ok: boolean; errors: string[] } {
  const behaviorKind = parseBehaviorKind(draftText);
  if (!behaviorKind) {
    return { ok: false, errors: ['behavior-kind floor: missing ```behavior-kind fence'] };
  }
  const result = checkPositiveOutcome(draftText);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors.map((error) => `behavior-kind floor: ${error}`),
    };
  }
  return { ok: true, errors: [] };
}

export function checkContractEvidenceFloor(
  draftText: string,
  options: TierGateFloorOptions = {},
): { ok: boolean; errors: string[] } {
  const repoRoot = options.repoRoot ?? process.cwd();
  const result = checkContractEvidence(draftText, {
    repoRoot,
    draftPath: options.draftPath,
  }) as { ok: boolean; errors: string[]; skipped?: boolean };
  if (result.ok || result.skipped) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: result.errors.map((error) => `contract-evidence floor: ${error}`),
  };
}

export function checkFindingLedgerFloor(
  options: TierGateFloorOptions = {},
): { ok: boolean; errors: string[]; skipped: boolean } {
  if (!options.draftPath) {
    return { ok: true, errors: [], skipped: true };
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const { captureFiles, ledgerPath } = resolveReviewArtifacts(options.draftPath, repoRoot);
  if (captureFiles.length === 0) {
    return { ok: true, errors: [], skipped: true };
  }
  const ledgerText = readFileSync(ledgerPath, 'utf8');
  const captures = captureFiles.map((capturePath) => readFileSync(capturePath, 'utf8'));
  const result = checkFindingLedgerGuard(captures, ledgerText, {
    repoRoot,
    draftPath: options.draftPath,
  });
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors.map((error) => `finding-ledger floor: ${error}`),
      skipped: false,
    };
  }
  return { ok: true, errors: [], skipped: false };
}

export function checkNeverSkippedFloors(
  draftText: string,
  options: TierGateFloorOptions = {},
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const checks = [
    checkWorkerSafetyFloor(draftText),
    checkBehaviorKindFloor(draftText),
    checkContractEvidenceFloor(draftText, options),
    checkFindingLedgerFloor(options),
  ];
  for (const check of checks) {
    if (!check.ok) {
      errors.push(...check.errors);
    }
  }
  return { ok: errors.length === 0, errors };
}
