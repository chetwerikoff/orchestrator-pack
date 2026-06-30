import { describe, expect, it } from 'vitest';
import {
  extractGhCommandsFromRuleSurface,
  extractGhCommandsFromRuleSurfaceLine,
  isClassifiedGhReadCommand,
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

  it('classifies RCA issue metadata and merged-PR closure lookup forms (Issue #520)', () => {
    expect(
      isInventoryCoveredCommand(
        'gh issue view <N> --repo chetwerikoff/orchestrator-pack --json state,title,body,closedAt',
      ),
    ).toBe(true);
    expect(
      isInventoryCoveredCommand(
        'gh pr list --repo chetwerikoff/orchestrator-pack --state merged --search "closes #N" --json number,title,state,mergedAt --limit 10',
      ),
    ).toBe(true);
  });

  it('ignores prose-only gh issue view mentions on RCA surfaces (Issue #520)', () => {
    expect(extractGhCommandsFromRuleSurfaceLine('| A | `gh issue view` → `state` is **closed** |')).toEqual([]);
    expect(
      extractGhCommandsFromRuleSurfaceLine(
        '- Open and closed GitHub Issues (via registry-resolved numbers and `gh issue view`);',
      ),
    ).toEqual([]);
  });

  it('fails on bare gh pr view and gh pr checks executable instructions (Issue #520)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-bare-'));
    const file = join(dir, 'rules.md');
    writeFileSync(file, 'Run `gh pr view 42` before merge.\n', 'utf8');
    const viewViolations = scanFileForViolations(file, 'rules');
    expect(viewViolations.some((v) => v.command.includes('gh pr view 42'))).toBe(true);

    writeFileSync(file, 'Run `gh pr checks 42` for CI.\n', 'utf8');
    const checksViolations = scanFileForViolations(file, 'rules');
    expect(checksViolations.some((v) => v.command.includes('gh pr checks 42'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });


  it('fails on unclassified pr view unknownField shape (Issue #546)', () => {
    expect(isInventoryCoveredCommand('gh pr view 123 --json unknownField')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-unknown-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(file, 'gh pr view 123 --json unknownField\n', 'utf8');
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations.some((v) => v.command.includes('unknownField'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes classified spawn-gate headRef shape and explicit REST api reads (Issue #546)', () => {
    expect(isInventoryCoveredCommand('gh pr view 527 --json headRefOid,headRefName')).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-covered-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(
      file,
      "gh pr view 527 --json headRefOid,headRefName\ngh api repos/o/r/pulls/527 --jq .head.sha\n",
      'utf8',
    );
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes investigate_root_cause.md RCA prompt scan (Issue #520)', () => {
    const violations = scanFileForViolations('prompts/investigate_root_cause.md', 'rules');
    expect(violations).toEqual([]);
  });

  it('classifies all in-scope executable gh read shapes (Issue #549)', async () => {
    const { validatePackGhReadInventoryCompleteness } = await import('./lib/graphql-quota-github-read-inventory.mjs');
    const result = validatePackGhReadInventoryCompleteness(process.cwd());
    expect(result.residualErrors).toEqual([]);
    expect(result.unclassified).toEqual([]);
  });

  it('fails inventory check when residual row lacks owner (Issue #549)', async () => {
    const { validateResidualOwnership } = await import('./lib/graphql-quota-github-read-inventory.mjs');
    expect(validateResidualOwnership()).toEqual([]);
  });

  it('fails on unowned gh api graphql in reconcile scripts (Issue #549)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-graphql-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(file, 'gh api graphql -f query={viewer{login}}\n', 'utf8');
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations.some((v) => v.command.includes('gh api graphql'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows classified rest_direct gh api repos reads (Issue #549)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-rest-direct-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(
      file,
      'gh api "repos/$Repository/issues/$PrNumber/events" --paginate\n',
      'utf8',
    );
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects rest_direct subpaths not anchored to the listed endpoint (Issue #549)', () => {
    expect(isInventoryCoveredCommand('gh api repos/o/r/commits/SHA/statuses')).toBe(false);
    expect(isInventoryCoveredCommand('gh api repos/o/r/issues/1/events/extra')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-rest-subpath-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(file, 'gh api repos/o/r/commits/SHA/statuses\n', 'utf8');
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations.some((v) => v.command.includes('commits/SHA/statuses'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects uncovered gh api repos reads with leading api options (Issue #549)', () => {
    expect(isClassifiedGhReadCommand('gh api --hostname ghe.example repos/o/r/commits/SHA/statuses')).toBe(false);
    expect(isClassifiedGhReadCommand('gh api --hostname ghe.example repos/o/r/commits/SHA')).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-api-flags-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(
      file,
      'gh api -H "Accept: application/vnd.github+json" repos/o/r/commits/SHA/statuses\n',
      'utf8',
    );
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations.some((v) => v.command.includes('commits/SHA/statuses'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on raw curl api.github.com in reconcile scripts (Issue #549)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-curl-'));
    const file = join(dir, 'sample.ps1');
    writeFileSync(file, 'curl -s https://api.github.com/repos/o/r/pulls/1\n', 'utf8');
    const violations = scanFileForViolations(file, 'reconcile');
    expect(violations.some((v) => /curl.*api\.github\.com/i.test(v.command))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

});
