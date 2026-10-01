// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../../.cursor/skills/create-issue-draft/SKILL.md', import.meta.url), 'utf8');
const tiering = readFileSync(new URL('../../docs/tiering.md', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../docs/browser-gpt-turn-runbook.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');

describe('current create-Issue authoring contract', () => {
  it('keeps routing and implementation precedence explicit', () => {
    expect(skill).toContain('standalone `manager` /');
    expect(skill).toContain('`execute-issue-with-gpt`');
    expect(agents).toContain('explicit implementation wording wins over a `manager` / `менеджер` noun');
  });

  it('owns review/disposition/acceptance in the skill and classification in tiering', () => {
    expect(skill).toContain('Classify through `docs/tiering.md#task-complexity-tier-rubric`');
    expect(skill).toContain('| T2 | Three independent GPT architectural reviews launched in parallel');
    expect(skill).toContain('After each required review round');
    expect(skill).toContain('Apply `spec-review:accepted` only when');
    expect(tiering).toContain('A task is T3 only when **both** are true');
    expect(tiering).toContain('Workflow-specific stage counts');
  });

  it('retains publisher attribution, substantive floor, and test-task scope decisions', () => {
    expect(skill).toContain('`user.login`');
    expect(skill).toContain('`author_association`');
    expect(skill).toContain('scripts/tier-gate-guard.ts --text');
    expect(skill).toContain('scripts/vitest-ci-lanes.config.json');
    expect(skill).toContain('scripts/lib/vitest-pre-topology-measurement.mjs');
  });

  it('keeps Browser-GPT transport workflow-neutral', () => {
    expect(browser).toContain('workflow-neutral');
    expect(browser).toContain('Possible/proven delivery forbids a blind resend');
    expect(browser).not.toContain('source-slot');
    expect(browser).not.toContain('terminal-bundle');
  });
});
