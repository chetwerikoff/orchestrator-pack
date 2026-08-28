import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(
  new URL('../../.cursor/skills/create-issue-draft/SKILL.md', import.meta.url),
  'utf8',
);
const standaloneSkill = readFileSync(
  new URL('../../.cursor/skills/discuss-with-gpt/SKILL.md', import.meta.url),
  'utf8',
);
const normalizedStandaloneSkill = standaloneSkill.replace(/\s+/g, ' ');
const startMarker = '## Downstream test-task authoring floor — Issue #1195';
const endMarker = '## Mechanical commands';
const start = skill.indexOf(startMarker);
const end = skill.indexOf(endMarker, start);
const authoringFloor = start >= 0 && end > start ? skill.slice(start, end) : '';
const normalizedFloor = authoringFloor.replace(/\s+/g, ' ').trim();

describe('Issue #1195 downstream test-task authoring floor', () => {
  it('identifies the static producer and fixed output vocabulary', () => {
    expect(authoringFloor).toContain('The checked-in skill is the authoring producer');
    expect(authoringFloor).toContain('not a deterministic Browser-GPT body generator');
    expect(authoringFloor).toContain('`scripts/vitest-ci-lanes.config.json`');
    expect(authoringFloor).toContain('`scripts/lib/vitest-pre-topology-measurement.mjs`');
    expect(authoringFloor).toContain('These values are Issue-body content');
    expect(authoringFloor).toContain('no worker, validator, runtime component');
  });

  it('defines the closed pre-handoff adds-tests predicate', () => {
    expect(authoringFloor).toContain(
      '`adds-tests` is true exactly when the requested scope or final plan, before',
    );
    for (const artifact of [
      'test source/spec/case',
      'test fixture',
      'golden file',
      'snapshot',
      'generated test source',
      'generated test artifact',
    ]) {
      expect(authoringFloor).toContain(artifact);
    }
    for (const exclusion of [
      'delete-only work',
      'ordinary source',
      'documentation',
      'test status',
      'pull-request filenames',
      'runtime discovery',
      'unchanged',
    ]) {
      expect(authoringFloor).toContain(exclusion);
    }
  });

  it('binds classification to the complete discovery boundary', () => {
    expect(authoringFloor).toContain('recursive `.test.ts`');
    expect(authoringFloor).toContain('under `plugins/` and `scripts/`');
    expect(authoringFloor).toContain('`tests/agents-md-*.test.ts`');
    expect(authoringFloor).toContain('every discovered path requires a');
    expect(authoringFloor).toContain('classification entry');
    for (const condition of [
      'new, renamed, or deleted',
      'stale entry',
      'needs a different lane classification',
      'classification entry intentionally changes',
      'existing classification remains valid',
      'outside the discovery boundary',
    ]) {
      expect(normalizedFloor).toContain(condition);
    }
  });

  it('keeps measurement selection independent from test classification', () => {
    expect(authoringFloor).toContain('Classification and measurement are independent decisions');
    for (const condition of [
      'pre-topology measurement mechanism',
      'unresolved-file handling',
      'measurement-specific behavior',
      'estimates',
      'thresholds',
      'mappings',
      'stale measurement data/logic',
      'existing mechanism use, not a measurement change',
    ]) {
      expect(normalizedFloor).toContain(condition);
    }
  });

  it('covers the decision matrix and unresolved return-to-author branch', () => {
    expect(authoringFloor).toContain('| Final-plan fact observed before handoff |');
    for (const row of [
      'New lane-discovered `.test.ts` or new `tests/agents-md-*.test.ts`',
      'Renamed or deleted lane-discovered Vitest test',
      'Modified discovered test needs a classification change',
      'Modified discovered test remains valid under its existing classification',
      'Unchanged discovered test has an intentional classification-only change',
      'Existing mechanism measures a changed test without measurement changes',
      'Author cannot observe whether classification or measurement changes',
      'No new, renamed, or modified artifact and no mechanism change',
    ]) {
      expect(authoringFloor).toContain(row);
    }
    expect(authoringFloor).toContain('emit no guessed output');
    expect(authoringFloor).toContain('do not hand off');
    expect(normalizedFloor).toContain('return the task to authoring');
  });

  it('requires concrete reconciliation without worker or runtime widening', () => {
    expect(authoringFloor).toContain('reconcile the final plan, `adds-tests`');
    expect(authoringFloor).toContain('names each concrete');
    expect(authoringFloor).toContain('classification output missing: scripts/vitest-ci-lanes.config.json');
    expect(authoringFloor).toContain('Report classification and measurement omissions');
    expect(authoringFloor).toContain('worker amendment');
    expect(authoringFloor).toContain('runtime authorization');
    expect(authoringFloor).toContain('producer wording comes before any validator');
    expect(normalizedFloor).toContain('validate this static floor');
    expect(authoringFloor).not.toContain('introduce a required diagnostic grammar');
  });
});

describe('standalone discuss-with-gpt terminal read-back contract', () => {
  it('requires authoritative artifact read-back before reporting terminal state', () => {
    expect(normalizedStandaloneSkill).toContain(
      'Before reporting any standalone terminal state, re-read the newest artifact',
    );
    expect(normalizedStandaloneSkill).toContain(
      '`~/.local/state/discuss-with-gpt/<draft-slug>/`',
    );
    expect(normalizedStandaloneSkill).toContain(
      'The on-disk record outranks agent recollection and any earlier tool refusal',
    );
    expect(normalizedStandaloneSkill).toContain(
      'A preflight refusal on one invocation path is not a terminal state while a `completed_valid` artifact exists for that PASS_ID',
    );
  });

  it('binds the standalone flow terminal step to the read-back', () => {
    expect(normalizedStandaloneSkill).toContain(
      '4. Validate PASS_ID/SHA and packet shape; record the durable state/artifact, then re-read the newest artifact before reporting any standalone terminal state.',
    );
  });
});
