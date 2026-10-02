// @vitest-ci-lane light
import { describe, expect, it, vi } from 'vitest';
import {
  resolveRequiredCi,
  type RequiredCiCheckRow,
  type RequiredCiProtectionRead,
  type ResolveRequiredCiInput,
} from './required-ci.ts';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

type RequiredCiTarget = ResolveRequiredCiInput['target'];

function target(overrides: Partial<RequiredCiTarget> = {}): RequiredCiTarget {
  return {
    projectId: 'leopoker',
    repository: 'chetwerikoff/LeoPoker',
    defaultBranch: 'main',
    ...overrides,
  };
}

function deps(input: {
  target?: ReturnType<typeof target>;
  expectedHeadSha?: string;
  prBaseRef?: string;
  protection?: RequiredCiProtectionRead;
  checks?: RequiredCiCheckRow[];
  postHead?: string;
}) {
  return {
    target: input.target ?? target({ requiredCi: ['CI / checks'] }),
    prNumber: 136,
    expectedHeadSha: input.expectedHeadSha ?? H1,
    prBaseRef: input.prBaseRef ?? 'main',
    readProtection: vi.fn(async () => input.protection ?? ({ kind: 'unavailable', httpStatus: 403 } as const)),
    readChecks: vi.fn(async () => input.checks ?? [{ workflow: 'CI', name: 'checks', state: 'SUCCESS' }]),
    readCurrentHead: vi.fn(async () => input.postHead ?? H1),
  };
}

describe('shared required CI resolver', () => {
  it('uses project-card workflow/job selectors before protection and binds green to the immediate post-projection head', async () => {
    const input = deps({});
    const result = await resolveRequiredCi(input);
    expect(result).toMatchObject({
      green: true,
      state: 'green',
      source: 'project_card',
      reason: 'green',
      expectedHeadSha: H1,
      postProjectionHeadSha: H1,
      headBinding: 'inferred_current',
    });
    expect(input.readProtection).not.toHaveBeenCalled();
    expect(input.readChecks).toHaveBeenCalledTimes(1);
    expect(input.readCurrentHead).toHaveBeenCalledTimes(1);
  });

  it('refuses missing workflow identity, wrong workflow, and any non-success surviving match', async () => {
    for (const checks of [
      [{ name: 'checks', state: 'SUCCESS' }],
      [{ workflow: 'Other Workflow', name: 'checks', state: 'SUCCESS' }],
    ]) {
      await expect(resolveRequiredCi(deps({ checks }))).resolves.toMatchObject({
        green: false,
        reason: 'required_selector_missing',
      });
    }
    await expect(resolveRequiredCi(deps({
      checks: [
        { workflow: 'CI', name: 'checks', state: 'SUCCESS' },
        { workflow: 'CI', name: 'checks', state: 'FAILURE' },
      ],
    }))).resolves.toMatchObject({ green: false, state: 'failure', reason: 'required_selector_failed' });
    await expect(resolveRequiredCi(deps({
      checks: [{ workflow: 'CI', name: 'checks', state: 'PENDING' }],
    }))).resolves.toMatchObject({ green: false, state: 'pending', reason: 'required_selector_pending' });
  });

  it('discards projected rows when the live head moves from H1 to H2', async () => {
    const result = await resolveRequiredCi(deps({ postHead: H2 }));
    expect(result).toMatchObject({
      green: false,
      state: 'pending',
      reason: 'head_changed',
      expectedHeadSha: H1,
      postProjectionHeadSha: H2,
      headBinding: 'mismatch',
    });
    expect(result.diagnostics).toContain('evidence_stale');
  });

  it('fails closed on a base/default mismatch before selector discovery or projection', async () => {
    const input = deps({ prBaseRef: 'develop' });
    const result = await resolveRequiredCi(input);
    expect(result).toMatchObject({ green: false, state: 'failure', reason: 'base_branch_mismatch' });
    expect(input.readProtection).not.toHaveBeenCalled();
    expect(input.readChecks).not.toHaveBeenCalled();
    expect(input.readCurrentHead).not.toHaveBeenCalled();
  });

  it('uses readable non-empty branch protection when the card omits requiredCi', async () => {
    const input = deps({
      target: target(),
      protection: { kind: 'ok', policy: { contexts: ['Classic Required'] } },
      checks: [{ name: 'classic required', state: 'SUCCESS' }],
    });
    await expect(resolveRequiredCi(input)).resolves.toMatchObject({
      green: true,
      source: 'branch_protection',
    });
  });

  it('keeps non-empty self-status-only protection distinct from raw-empty policy', async () => {
    const input = deps({
      target: target(),
      protection: { kind: 'ok', policy: { contexts: ['orchestrator-pack/pack-review'] } },
      checks: [],
    });
    await expect(resolveRequiredCi(input)).resolves.toMatchObject({
      green: true,
      source: 'branch_protection',
      selectors: [],
    });
  });

  it('uses merge-contract fallback only for the canonical pack target when readable protection is raw-empty', async () => {
    const packTarget = target({
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
    });
    const checks = [
      { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
      { name: 'PR scope guard', state: 'SUCCESS' },
      { name: 'Run pack contract tests', state: 'SUCCESS' },
      { name: 'Self-architect lint', state: 'SUCCESS' },
    ];
    await expect(resolveRequiredCi(deps({
      target: packTarget,
      protection: { kind: 'ok', policy: { contexts: [], checks: [] } },
      checks,
    }))).resolves.toMatchObject({ green: true, source: 'merge_contract_fallback' });

    const nonPack = deps({
      target: target(),
      protection: { kind: 'ok', policy: { contexts: [], checks: [] } },
      checks,
    });
    await expect(resolveRequiredCi(nonPack)).resolves.toMatchObject({
      green: false,
      source: 'none',
      reason: 'no_required_ci_configured',
    });
    expect(nonPack.readChecks).not.toHaveBeenCalled();
  });

  it('reports protection 403/404 as lookup_unavailable instead of inventing a bare check fallback', async () => {
    for (const httpStatus of [403, 404] as const) {
      const input = deps({
        target: target(),
        protection: { kind: 'unavailable', httpStatus },
      });
      await expect(resolveRequiredCi(input)).resolves.toMatchObject({
        green: false,
        source: 'lookup_unavailable',
        reason: 'lookup_unavailable',
      });
      expect(input.readChecks).not.toHaveBeenCalled();
    }
  });
});
