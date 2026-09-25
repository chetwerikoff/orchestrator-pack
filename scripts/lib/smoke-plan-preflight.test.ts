import { describe, expect, it } from 'vitest';
import {
  SHARED_OPERATOR_RESOURCE_PERMIT,
  evaluateSmokePlanPreflight,
} from './smoke-plan-preflight.ts';

const artifactDir = '/tmp/orchestrator-pack/.orca-worker-smoke/runs/run-2151';

function body(action: string, options: { revision?: string; permit?: boolean } = {}): string {
  return [
    `<!-- source-revision: ${options.revision ?? 'r10'} -->`,
    '```smoke-test-plan',
    ...(options.permit ? [SHARED_OPERATOR_RESOURCE_PERMIT] : []),
    'scenarios:',
    `  - action: ${action} | expected: observable result`,
    '```',
  ].join('\n');
}

function evaluate(action: string, options: { revision?: string; permit?: boolean } = {}) {
  const issueBody = body(action, options);
  return evaluateSmokePlanPreflight({
    issueBody,
    artifactDir,
    scenarios: [{ action, expected: 'observable result' }],
  });
}

describe('worker-smoke plan ownership preflight', () => {
  it('rejects an absolute worktree path outside the run artifactDir', () => {
    expect(evaluate('use fixture worktree /tmp/orchestrator-pack/worktrees/foreign-run')).toMatchObject({
      ok: false,
      causeFamily: 'scenario_precondition_unavailable',
      violation: { reason: 'absolute_worktree_path_outside_artifact_dir', scenarioOrdinal: 1 },
    });
  });

  it('rejects the shared operator CDP endpoint without the exact permit comment', () => {
    expect(evaluate('run browser check with --cdp http://127.0.0.1:9222')).toMatchObject({
      ok: false,
      causeFamily: 'scenario_precondition_unavailable',
      violation: { reason: 'shared_operator_cdp_requires_permit', scenarioOrdinal: 1 },
    });
  });

  it('rejects the operator local config without the exact permit comment', () => {
    expect(evaluate('read /home/operator/orchestrator-pack/.claude/skills/discuss-with-gpt/local.config.json')).toMatchObject({
      ok: false,
      causeFamily: 'scenario_precondition_unavailable',
      violation: { reason: 'shared_operator_local_config_requires_permit', scenarioOrdinal: 1 },
    });
  });

  it('rejects a hardcoded source revision different from the live Issue marker', () => {
    expect(evaluate('invoke manager with --source-revision r09')).toMatchObject({
      ok: false,
      causeFamily: 'scenario_precondition_unavailable',
      violation: { reason: 'source_revision_mismatch', scenarioOrdinal: 1 },
    });
  });

  it('admits an exact-head fixture owned by artifactDir with the live revision read dynamically', () => {
    const action = `git worktree add --detach ${artifactDir}/fixtures/scenario-01 HEAD; read SOURCE_REVISION from the live source-revision marker; start a run-owned browser on http://127.0.0.1:43125; remove the fixture`;
    expect(evaluate(action)).toEqual({ ok: true });
  });

  it('admits an explicitly permitted shared operator resource without weakening the other checks', () => {
    expect(evaluate('inspect http://localhost:9222', { permit: true })).toEqual({ ok: true });
    expect(evaluate('use fixture worktree /tmp/orchestrator-pack/worktrees/foreign-run', { permit: true })).toMatchObject({
      ok: false,
      violation: { reason: 'absolute_worktree_path_outside_artifact_dir' },
    });
  });
});
