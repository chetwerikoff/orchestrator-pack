import { checkNeverSkippedFloors } from './tier-gate-floor.ts';

export { checkWorkerSafetyFloor } from './tier-gate-floor.ts';

export const VALID_TIERS = new Set(['T1', 'T2', 'T3']);
export type Tier = 'T1' | 'T2' | 'T3';

export type ComplexityTierFence =
  | { kind: 'tier-fence'; tier: Tier; riskNote?: string }
  | { kind: 'unparseable'; reason: string };

const FENCE_RE = /`{3}complexity-tier\s*\n([\s\S]*?)`{3}/i;

export function parseComplexityTierFence(draftText: string): ComplexityTierFence {
  const match = draftText.match(FENCE_RE);
  if (!match) return { kind: 'unparseable', reason: 'missing complexity-tier fence' };
  const fields = new Map<string, string>();
  for (const raw of (match[1] ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) {
      return { kind: 'unparseable', reason: 'invalid complexity-tier line: ' + line };
    }
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const tier = (fields.get('tier') ?? '').toUpperCase();
  if (!VALID_TIERS.has(tier)) {
    return { kind: 'unparseable', reason: 'complexity-tier tier must be T1, T2, or T3' };
  }
  return {
    kind: 'tier-fence',
    tier: tier as Tier,
    ...(fields.get('risk-note') ? { riskNote: fields.get('risk-note') } : {}),
  };
}

export interface TierGateGuardResult {
  ok: boolean;
  errors: string[];
  fence: ComplexityTierFence;
}

export function checkTierGateGuard(
  text: string,
  options: { repoRoot?: string; draftPath?: string } = {},
): TierGateGuardResult {
  const floor = checkNeverSkippedFloors(text, options);
  const fence = parseComplexityTierFence(text);
  const errors = [...floor.errors];
  if (fence.kind === 'unparseable') errors.push('complexity-tier floor: ' + fence.reason);
  return { ok: errors.length === 0, errors, fence };
}

export function formatTierGatePassMessage(result: TierGateGuardResult): string {
  if (!result.ok || result.fence.kind !== 'tier-fence') {
    throw new Error('tier-gate result is not PASS');
  }
  return 'tier-gate guard: PASS ' + result.fence.tier;
}
