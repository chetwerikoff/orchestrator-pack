import { describe, expect, it } from 'vitest';
import {
  extractGhCommandsFromRuleSurface,
  extractGhCommandsFromRuleSurfaceLine,
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

  it('detects unknown gh read forms such as gh issue list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-'));
    const file = join(dir, 'rules.md');
    writeFileSync(
      file,
      'Inspect with `gh issue list --json number` before spawning.\n',
      'utf8',
    );
    const violations = scanFileForViolations(file, 'rules');
    expect(violations.some((v) => v.command.includes('gh issue list'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects forbidden gh api graphql transport in instruct lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-'));
    const file = join(dir, 'rules.md');
    writeFileSync(
      file,
      'When blocked, run `gh api graphql -f query=...` as a fallback.\n',
      'utf8',
    );
    const violations = scanFileForViolations(file, 'rules');
    expect(violations.some((v) => v.command.includes('gh api graphql'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores family mentions and prohibition documentation lines', () => {
    expect(extractGhCommandsFromRuleSurfaceLine('routes `gh pr list/view/checks/diff` to REST')).toEqual([]);
    expect(
      extractGhCommandsFromRuleSurfaceLine(
        '**Forbidden transports:** agents MUST NOT use `gh api graphql` or raw curl.',
      ),
    ).toEqual([]);
    expect(extractGhCommandsFromRuleSurfaceLine('`gh pr checks` stay verbatim per passthrough')).toEqual([]);
  });
});
