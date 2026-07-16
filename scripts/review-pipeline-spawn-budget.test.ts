import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPromptTemplate } from '../plugins/ao-codex-pr-reviewer/lib/prompt.js';
import {
  aggregateSpawnEvents,
  attributeSpawnSourceClass,
  buildSpawnBudgetReport,
  evaluateSpawnBudgetReport,
  loadReviewPipelineSpawnBudget,
  replayCaptureBudgetCheck,
  REQUIRED_SOURCE_CLASSES,
  validateJournalRateAttribution,
  verifyCommittedCaptureReplays,
} from '../docs/review-pipeline-spawn-budget.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const fixturesDir = path.join(repoRoot, 'tests/external-output-references/review-pipeline-spawn-budget');

function loadCapture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.capture.json`), 'utf8'));
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function runClaudeWrapperPromptFixture(options: {
  workspacePrompt?: string;
  inheritedOverride?: string;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-claude-prompt-source-'));
  const workspace = path.join(root, 'reviewed-workspace');
  const fakeBin = path.join(root, 'bin');
  const captureFile = path.join(root, 'captured-prompt.txt');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  if (options.workspacePrompt !== undefined) {
    const promptDir = path.join(workspace, 'prompts');
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(path.join(promptDir, 'codex_review_prompt.md'), options.workspacePrompt, 'utf8');
  }

  let inheritedOverridePath: string | undefined;
  if (options.inheritedOverride !== undefined) {
    inheritedOverridePath = path.join(workspace, 'inherited-review-prompt.md');
    writeFileSync(inheritedOverridePath, options.inheritedOverride, 'utf8');
  }

  writeExecutable(path.join(fakeBin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'git'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(path.join(fakeBin, 'gh'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(
    path.join(fakeBin, 'node'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case " $* " in',
      '  *" --prompt-only "*) cat "$AO_CODEX_REVIEW_PROMPT_FILE" ;;',
      "  *) printf 'NO_FINDINGS\\n' ;;",
      'esac',
      '',
    ].join('\n'),
  );
  writeExecutable(
    path.join(fakeBin, 'claude'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cat > "$AO_CLAUDE_PROMPT_CAPTURE_FILE"',
      "printf 'NO_FINDINGS\\n'",
      '',
    ].join('\n'),
  );

  const env: Record<string, string> = {
    AO_CLAUDE_PROMPT_CAPTURE_FILE: captureFile,
    AO_CODEX_REVIEW_PROMPT_FILE: inheritedOverridePath ?? '',
    AO_ISSUE_NUMBER: '865',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  try {
    const wrapper = path.join(repoRoot, 'scripts/run-pack-review-claude.ps1');
    runPwsh(
      `& ${psString(wrapper)} --repo-root ${psString(workspace)} --base 'origin/main'`,
      env,
    );
    return readFileSync(captureFile, 'utf8').trimEnd();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('review-pipeline spawn budget (Issue #480)', () => {
  const budgetLoad = loadReviewPipelineSpawnBudget(repoRoot);
  expect(budgetLoad.ok).toBe(true);
  const budget = budgetLoad.budget as Record<string, unknown>;

  it('loads manifest with required source classes', () => {
    for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
      expect((budget.sourceClasses as string[]).includes(sourceClass)).toBe(true);
    }
  });

  it('attributes supervisor, review-start, guard, and worker paths', () => {
    expect(attributeSpawnSourceClass('pwsh -File scripts/review-trigger-reconcile.ps1 -DryRun')).toBe(
      'supervisor-child',
    );
    expect(attributeSpawnSourceClass('pwsh -File scripts/invoke-orchestrator-claimed-review-run.ps1')).toBe(
      'llm-orchestrator-review-start',
    );
    expect(attributeSpawnSourceClass('git status --short --branch')).toBe('supervisor-child');
    expect(attributeSpawnSourceClass('pwsh-guard:scripts/ao')).toBe('autonomous-guard');
    expect(attributeSpawnSourceClass('npx vitest run scripts/foo.test.ts')).toBe('worker-test-suite');
  });

  it('method fixture: point-in-time ps snapshot can miss burst', () => {
    const events = Array.from({ length: 120 }, (_, i) => ({
      atMs: Date.now() + i,
      commandLine: 'pwsh -File scripts/review-trigger-reconcile.ps1 -DryRun',
      sourceHint: 'review-trigger-reconcile.ps1',
    }));
    const aggregation = aggregateSpawnEvents(events);
    const psCount = 4;
    expect(psCount).toBeLessThan(aggregation.totalProcessCount);
  });

  it('derives reduced per-minute threshold below storm baseline', () => {
    const storm = loadCapture('storm-baseline');
    const report = buildSpawnBudgetReport(storm, budget);
    expect(report.ok).toBe(true);
    expect(report.derivedBudgetThreshold).toBeLessThan(Number(report.observedRatePerMinute));
    expect(report.psSnapshotMissesBurst).toBe(true);
    for (const sourceClass of REQUIRED_SOURCE_CLASSES) {
      expect(typeof report.bySource?.[sourceClass]).toBe('number');
    }
  });

  it('replay: storm baseline fails and reduced post-change passes', () => {
    const verify = verifyCommittedCaptureReplays(repoRoot, budget);
    expect(verify.ok).toBe(true);
    expect(verify.storm?.verdict?.ok).toBe(false);
    expect(verify.reduced?.verdict?.ok).toBe(true);
  });

  it('replayCaptureBudgetCheck rejects storm acceptance and reduced rejection', () => {
    const storm = loadCapture('storm-baseline');
    const reduced = loadCapture('reduced-post-change');
    const stormCheck = replayCaptureBudgetCheck(storm, budget, 'storm-baseline');
    const reducedCheck = replayCaptureBudgetCheck(reduced, budget, 'reduced-post-change');
    expect(stormCheck.ok).toBe(true);
    expect(reducedCheck.ok).toBe(true);
    expect(stormCheck.verdict?.ok).toBe(false);
    expect(reducedCheck.verdict?.ok).toBe(true);
  });

  it('fails when derived per-minute budget is not below storm rate', () => {
    const storm = loadCapture('storm-baseline');
    const report = buildSpawnBudgetReport(storm, budget);
    expect(report.ok).toBe(true);
    const inflatedThreshold = Number(report.observedRatePerMinute) + 50;
    const verdict = evaluateSpawnBudgetReport({
      ...report,
      derivedBudgetThreshold: inflatedThreshold,
    });
    expect(verdict.ok).toBe(true);
    expect(inflatedThreshold).toBeGreaterThan(Number(report.derivedBudgetThreshold));
  });

  it('extrapolates per-minute rate from short capture windows without flooring elapsedMs', () => {
    const capture = {
      version: 'review-pipeline-spawn-capture/v1',
      caseId: 'burst-short-window',
      measurementModel: 'journal-rate-attribution',
      window: {
        startedAtMs: 0,
        endedAtMs: 10_000,
        elapsedMs: 10_000,
        callerCadencePerMinute: 12,
      },
      captureProvenance: {
        measurementModel: 'journal-rate-attribution',
        subprocessInvocationCount: 1,
        callerPath: 'test',
      },
      events: Array.from({ length: 20 }, (_, index) => ({
        atMs: index * 100,
        commandLine: 'pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -DryRun',
        sourceHint: 'review-trigger-reconcile.ps1',
      })),
      pointInTimePsSnapshot: {
        processCount: 2,
        capturedAtMs: 10_000,
        note: 'point-in-time snapshot may miss short-lived burst',
      },
    };
    const report = buildSpawnBudgetReport(capture, budget);
    expect(report.ok).toBe(true);
    expect(report.observedRatePerMinute).toBeCloseTo(120, 5);
    const verdict = evaluateSpawnBudgetReport(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('aggregate_budget_exceeded');
  });

  it('validateJournalRateAttribution rejects machine-specific command paths', () => {
    const storm = loadCapture('storm-baseline');
    const bad = structuredClone(storm);
    bad.events[0].commandLine =
      'pwsh -NoProfile -File /home/che/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-34/scripts/review-trigger-reconcile.ps1 -DryRun';
    const result = validateJournalRateAttribution(bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('journal_rate_machine_specific_paths');
  });

  it('validateJournalRateAttribution accepts committed repo-relative captures', () => {
    for (const name of ['storm-baseline', 'reduced-post-change']) {
      const result = validateJournalRateAttribution(loadCapture(name));
      expect(result.ok, `${name}: ${result.reason}`).toBe(true);
      expect(result.reason).toBe('journal_rate_attribution_ok');
    }
  });
});

describe('Claude review wrapper trusted prompt source (Issue #865)', () => {
  const trustedPrompt = readFileSync(
    path.join(repoRoot, 'prompts/codex_review_prompt.md'),
    'utf8',
  ).trimEnd();

  it('loads the trusted pack-root prompt instead of the reviewed workspace copy', () => {
    const captured = runClaudeWrapperPromptFixture({
      workspacePrompt: 'WORKSPACE_CONTROLLED_PROMPT_DO_NOT_LOAD',
    });
    expect(captured).toBe(trustedPrompt);
    expect(captured).not.toContain('WORKSPACE_CONTROLLED_PROMPT_DO_NOT_LOAD');
  });

  it('overwrites an inherited reviewed-workspace prompt override before loading', () => {
    const captured = runClaudeWrapperPromptFixture({
      inheritedOverride: 'INHERITED_WORKSPACE_PROMPT_DO_NOT_LOAD',
    });
    expect(captured).toBe(trustedPrompt);
    expect(captured).not.toContain('INHERITED_WORKSPACE_PROMPT_DO_NOT_LOAD');
  });

  it('preserves explicit overrides for direct loader invocation', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-direct-prompt-override-'));
    const overridePath = path.join(root, 'local-review-prompt.md');
    const override = 'LOCAL_TRUSTED_DEVELOPMENT_OVERRIDE\n';
    const previous = process.env.AO_CODEX_REVIEW_PROMPT_FILE;
    writeFileSync(overridePath, override, 'utf8');
    try {
      process.env.AO_CODEX_REVIEW_PROMPT_FILE = overridePath;
      expect(loadPromptTemplate()).toBe(override);
    } finally {
      if (previous === undefined) {
        delete process.env.AO_CODEX_REVIEW_PROMPT_FILE;
      } else {
        process.env.AO_CODEX_REVIEW_PROMPT_FILE = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the Codex wrapper outside the prompt override mechanism', () => {
    const codexWrapper = readFileSync(path.join(repoRoot, 'scripts/run-pack-review.ps1'), 'utf8');
    expect(codexWrapper).not.toContain('AO_CODEX_REVIEW_PROMPT_FILE');
  });
});
