import { describe, expect, it } from 'vitest';
import {
  extractGhCommandsFromRuleSurface,
  isInventoryCoveredCommand,
  scanFileForViolations,
} from './lib/gh-inventory-static-guard.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('gh inventory static guard', () => {
  it('extracts merge-verify and CI-read forms from rule surfaces', () => {
    const text = `
      e.g. gh pr view <n> --json state,mergedAt
      gh pr checks <n> --json name,state,bucket,link,startedAt,completedAt,workflow,description
    `;
    const forms = extractGhCommandsFromRuleSurface(text);
    expect(forms).toContain('gh pr view <n> --json state,mergedAt');
    expect(forms.some((form: string) => form.includes('gh pr checks <n> --json'))).toBe(true);
  });

  it('classifies covered orchestrator forms as inventory-covered', () => {
    expect(isInventoryCoveredCommand('gh pr view <n> --json state,mergedAt')).toBe(true);
    expect(
      isInventoryCoveredCommand(
        'gh pr checks <n> --json name,state,bucket,link,startedAt,completedAt,workflow,description',
      ),
    ).toBe(true);
  });

  it('fails when a rule surface contains an uncovered gh read form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-'));
    const file = join(dir, 'rules.md');
    writeFileSync(
      file,
      'Run `gh pr view <n> --json commits` for merge verification.\n',
      'utf8',
    );
    const violations = scanFileForViolations(file, 'rules');
    expect(violations.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
