import { describe, expect, it } from 'vitest';
import { aggregateChecks, checkRunToContext } from '../lib/gh-pr-checks.mjs';
import { classifyArgv } from '../lib/gh-inventory-match.mjs';
import {
  PACK_REVIEW_CONTEXT,
  evaluateRequiredChecks,
  normalizeCurrentRequiredPolicy,
  projectPackReviewStatusHistory,
} from '../vitest-runtime-history-delivery.mjs';

const APP_ID = 15368;
const REQUIRED = 'Verify orchestrator-pack structure';
const LEGACY = 'Contract evidence legacy list guard';

function policy(appId: number | null = APP_ID) {
  return {
    strict: true,
    checks: [
      { context: REQUIRED, app_id: appId },
      { context: LEGACY, app_id: null },
      { context: PACK_REVIEW_CONTEXT, app_id: null },
    ],
  };
}

function checks(appId: number | null = APP_ID) {
  return [
    { name: REQUIRED, state: 'SUCCESS', bucket: 'pass', appId },
    { name: LEGACY, state: 'SUCCESS', bucket: 'pass', appId: null },
  ];
}

const emptyProjection = projectPackReviewStatusHistory([]);

describe('Issue #1012 required GitHub App proof', () => {
  it('keeps the legacy fail-closed policy parser default when provider proof is unavailable', () => {
    const parsed = normalizeCurrentRequiredPolicy(policy());
    expect(parsed.ok).toBe(false);
    expect(parsed.outcome).toBe('current-policy-unsupported');
  });

  it('preserves app_id when the caller explicitly has provider proof', () => {
    const parsed = normalizeCurrentRequiredPolicy(policy(), { providerProofAvailable: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toContainEqual({ context: REQUIRED, appId: APP_ID });
  });

  it('allows machine admission only when the exact required check proves the matching app id', () => {
    const parsed = normalizeCurrentRequiredPolicy(policy(), { providerProofAvailable: true });
    const decision = evaluateRequiredChecks({
      checks: checks(),
      policy: parsed,
      packReviewProjection: emptyProjection,
    });
    expect(decision.action).toBe('machine-admit');
  });

  it('fails closed when a green same-name check comes from another app', () => {
    const parsed = normalizeCurrentRequiredPolicy(policy(), { providerProofAvailable: true });
    const decision = evaluateRequiredChecks({
      checks: checks(APP_ID + 1),
      policy: parsed,
      packReviewProjection: emptyProjection,
    });
    expect(decision.action).toBe('fail');
    expect(decision.outcome).toBe('required-provider-unproven');
    expect(decision.reason).toContain(`${REQUIRED}@${APP_ID}`);
  });

  it('fails closed when app identity is missing from a terminal green check', () => {
    const parsed = normalizeCurrentRequiredPolicy(policy(), { providerProofAvailable: true });
    const decision = evaluateRequiredChecks({
      checks: checks(null),
      policy: parsed,
      packReviewProjection: emptyProjection,
    });
    expect(decision.action).toBe('fail');
    expect(decision.outcome).toBe('required-provider-unproven');
  });

  it('keeps app-restricted pack-review unsupported instead of publishing an unprovable status', () => {
    const parsed = normalizeCurrentRequiredPolicy({
      strict: true,
      checks: [
        { context: REQUIRED, app_id: APP_ID },
        { context: LEGACY, app_id: null },
        { context: PACK_REVIEW_CONTEXT, app_id: APP_ID },
      ],
    }, { providerProofAvailable: true });
    const decision = evaluateRequiredChecks({
      checks: checks(),
      policy: parsed,
      packReviewProjection: emptyProjection,
    });
    expect(decision.action).toBe('fail');
    expect(decision.outcome).toBe('current-policy-unsupported');
  });

  it('extracts check_run.app.id only for the explicit app-aware aggregate shape', () => {
    const context = checkRunToContext({
      name: REQUIRED,
      status: 'completed',
      conclusion: 'success',
      app: { id: APP_ID },
      started_at: '2026-07-26T00:00:00Z',
      completed_at: '2026-07-26T00:00:01Z',
    });
    expect(aggregateChecks([context])[0]).not.toHaveProperty('appId');
    expect(aggregateChecks([context], { includeAppId: true })[0].appId).toBe(APP_ID);
  });

  it('classifies app-aware pr checks separately while preserving the canonical shape', () => {
    const baseFields = 'name,state,bucket,link,startedAt,completedAt,workflow,description';
    const canonical = classifyArgv(['pr', 'checks', '1009', '--json', baseFields]).route;
    const appAware = classifyArgv(['pr', 'checks', '1009', '--json', `${baseFields},appId`]).route;
    expect(canonical?.id).toBe('pr-checks');
    expect(canonical?.includeAppId).toBe(false);
    expect(appAware?.id).toBe('pr-checks');
    expect(appAware?.includeAppId).toBe(true);
  });
});
