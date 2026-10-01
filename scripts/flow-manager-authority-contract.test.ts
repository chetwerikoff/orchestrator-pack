// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

describe('current create-Issue and Browser-GPT authority boundaries', () => {
  it('keeps create-Issue procedure comment/disposition/label based', () => {
    const skill = read('.cursor/skills/create-issue-draft/SKILL.md');
    expect(skill).toContain('Three independent GPT architectural reviews launched in parallel');
    expect(skill).toContain('After each required review round');
    expect(skill).toContain('spec-review:accepted');
    expect(skill).toContain('user.login');
    for (const retired of [
      'manager-review-brief-canon',
      'stageAttemptId',
      'terminal-input-bundle',
      'create-issue-final-acceptance/v1',
      'claude-unavailable-waiver',
      'finding-disposition-ledger.json',
    ]) expect(skill).not.toContain(retired);
  });

  it('keeps the manager Browser-GPT adapter transport-only', () => {
    const adapter = read('scripts/flow-manager-browser-gpt-long-run.ts');
    expect(adapter).toContain("'--invocation-id'");
    expect(adapter).toContain("'--project-url'");
    expect(adapter).toContain("'--chat-url'");
    for (const retired of [
      'reviewer-source-output',
      'stage-attempt-id',
      'source-slot',
      'terminal-input-bundle',
      'createIssue',
    ]) expect(adapter).not.toContain(retired);
  });

  it('keeps the long-running child transport-only', () => {
    const child = read('scripts/flow-manager-long-running-child.ts');
    expect(child).toContain("HANDOFF_SCHEMA = 'flow-manager-long-running-child-handoff/v1'");
    expect(child).toContain("TERMINAL_SCHEMA = 'flow-manager-long-running-child-terminal/v1'");
    expect(child).toContain('POSSIBLY_DELIVERED');
    expect(child).not.toContain('PublicationExpectation');
    expect(child).not.toContain('classifyConcurrentBatchDelivery');
  });

  it('keeps the shared runbook separate from create-Issue acceptance', () => {
    const browser = read('docs/browser-gpt-turn-runbook.md');
    const orchestration = read('docs/orchestration-runbook.md');
    expect(browser).toContain('Possible/proven delivery forbids a blind resend');
    expect(browser).not.toContain('stageAttemptId');
    expect(orchestration).toContain('.cursor/skills/create-issue-draft/SKILL.md');
  });
});
