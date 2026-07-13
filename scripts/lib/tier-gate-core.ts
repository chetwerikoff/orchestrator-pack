/**
 * Tier gate core: marker screen, fence parsing, stage selection, floor checks (Issue #576).
 */
import { screenRedFlagMarkers } from './tier-marker-screen.js';
import { checkNeverSkippedFloors } from './tier-gate-floor.js';

export { checkWorkerSafetyFloor } from './tier-gate-floor.js';

export const VALID_TIERS = new Set(['T1', 'T2', 'T3']);
export const FLOOR_CHECKS = [
  'worker-safety',
  'contract-evidence',
  'behavior-kind',
  'finding-ledger-carve-out',
] as const;

const FENCE_RE = /```complexity-tier\s*\n([\s\S]*?)```/i;

export type ComplexityTierFence =
  | { kind: 'tier-fence'; tier: string; advisoryPrior?: string; skipLine: false }
  | { kind: 'no-tier'; skipLine: true }
  | { kind: 'unparseable'; reason: string };

export function parseComplexityTierFence(draftText: string): ComplexityTierFence {
  const match = draftText.match(FENCE_RE);
  if (!match) {
    return { kind: 'unparseable', reason: 'missing complexity-tier fence' };
  }

  const body = match[1] ?? '';
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const fields = new Map<string, string>();
  for (const line of lines) {
    const sep = line.indexOf(':');
    if (sep < 0) {
      return { kind: 'unparseable', reason: `invalid complexity-tier line: ${line}` };
    }
    fields.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
  }

  const skipLineRaw = fields.get('skip-line');
  if (skipLineRaw && /^(true|yes|1)$/i.test(skipLineRaw)) {
    return { kind: 'no-tier', skipLine: true };
  }

  const tier = fields.get('tier')?.toUpperCase();
  if (!tier || !VALID_TIERS.has(tier)) {
    return { kind: 'unparseable', reason: `invalid or missing tier: ${tier ?? '<empty>'}` };
  }

  const advisoryPrior = fields.get('advisory-prior')?.toUpperCase();
  return {
    kind: 'tier-fence',
    tier,
    advisoryPrior: advisoryPrior && VALID_TIERS.has(advisoryPrior) ? advisoryPrior : undefined,
    skipLine: false,
  };
}

export interface StageSelectionInput {
  tier: string | null;
  skipLine: boolean;
  explicitAdversarialWrapper?: boolean;
}

export interface StageSelectionResult {
  effectiveTier: string | null;
  floor: string[];
  authoring: string[];
  review: string[];
  wrapperFloorApplied: boolean;
}

export function selectAuthoringReviewStages(input: StageSelectionInput): StageSelectionResult {
  const floor = [...FLOOR_CHECKS];
  const authoring: string[] = [];
  const review: string[] = [];

  if (input.skipLine) {
    return { effectiveTier: null, floor, authoring, review, wrapperFloorApplied: false };
  }

  let effectiveTier = input.tier;
  let wrapperFloorApplied = false;
  if (input.explicitAdversarialWrapper && effectiveTier === 'T1') {
    effectiveTier = 'T2';
    wrapperFloorApplied = true;
  }

  if (effectiveTier === 'T1') {
    review.push('light-architectural');
  } else if (effectiveTier === 'T2') {
    authoring.push('light-design-analysis');
    review.push('architectural');
    if (input.explicitAdversarialWrapper) {
      review.unshift('competitive-adversarial');
    }
  } else if (effectiveTier === 'T3') {
    authoring.push('full-design-analysis');
    review.push(
      'competitive-adversarial',
      'architectural',
      'architect-lens',
      'final-architectural',
    );
  }

  return { effectiveTier, floor, authoring, review, wrapperFloorApplied };
}

function designAdversarialSkipped(stages: StageSelectionResult) {
  const designSkipped = !stages.authoring.includes('full-design-analysis')
    && !stages.authoring.includes('light-design-analysis');
  const adversarialSkipped = !stages.review.includes('competitive-adversarial');
  return { designSkipped, adversarialSkipped };
}

export interface TierGateGuardOptions {
  tier?: string | null;
  skipLine?: boolean;
  designSkipped?: boolean;
  adversarialSkipped?: boolean;
  explicitAdversarialWrapper?: boolean;
  repoRoot?: string;
  draftPath?: string;
}

export type TierGateReceipt =
  | { kind: 'no-tier'; skipLine: true; markers: string[] }
  | {
      kind: 'tier-fence';
      tier: string;
      advisoryPrior?: string;
      markers: string[];
      effectiveTier: string | null;
      wrapperFloorApplied: boolean;
      explicitAdversarialWrapper: boolean;
    };

export interface TierGateGuardResult {
  ok: boolean;
  errors: string[];
  receipt: TierGateReceipt | null;
  screen: ReturnType<typeof screenRedFlagMarkers>;
  fence: ComplexityTierFence;
  stages: StageSelectionResult;
}

export function checkTierGateGuard(
  text: string,
  opts: TierGateGuardOptions = {},
): TierGateGuardResult {
  const errors: string[] = [];
  const fence = parseComplexityTierFence(text);
  const screen = screenRedFlagMarkers(text, {
    repoRoot: opts.repoRoot,
    draftPath: opts.draftPath,
  });

  if (screen.unparseable) {
    errors.push('marker screen: vocabulary/heuristic map incomplete — fail closed to T3');
  }

  const tier = opts.tier ?? (fence.kind === 'tier-fence' ? fence.tier : null);
  const skipLine = opts.skipLine ?? (fence.kind === 'no-tier');

  const stages = selectAuthoringReviewStages({
    tier,
    skipLine,
    explicitAdversarialWrapper: opts.explicitAdversarialWrapper,
  });

  const skipped = designAdversarialSkipped(stages);
  const designSkipped = opts.designSkipped ?? skipped.designSkipped;
  const adversarialSkipped = opts.adversarialSkipped ?? skipped.adversarialSkipped;

  if (screen.hits.length > 0) {
    if (tier && tier !== 'T3') {
      errors.push(
        `red-flag marker hit (${screen.hits.join(', ')}) with tier ${tier} below T3`,
      );
    }
    if (designSkipped) {
      errors.push(
        `red-flag marker hit (${screen.hits.join(', ')}) with design-analysis stage skipped`,
      );
    }
    if (adversarialSkipped && !opts.explicitAdversarialWrapper) {
      errors.push(
        `red-flag marker hit (${screen.hits.join(', ')}) with adversarial stage skipped`,
      );
    }
    if (skipLine) {
      errors.push(
        `red-flag marker hit (${screen.hits.join(', ')}) on skip-line input — marker dominance`,
      );
    }
  }

  if (fence.kind === 'unparseable' && !skipLine) {
    errors.push(`unparseable complexity-tier fence — fail closed (${fence.reason})`);
  }

  if (screen.unparseable && (!tier || tier !== 'T3')) {
    errors.push('unparseable marker screen — fail closed to T3');
  }

  const workerSafety = checkNeverSkippedFloors(text, {
    repoRoot: opts.repoRoot,
    draftPath: opts.draftPath,
  });
  if (!workerSafety.ok) {
    errors.push(...workerSafety.errors);
  }

  let receipt: TierGateReceipt | null = null;
  if (errors.length === 0) {
    if (skipLine || fence.kind === 'no-tier') {
      receipt = { kind: 'no-tier', skipLine: true, markers: screen.hits };
    } else {
      receipt = {
        kind: 'tier-fence',
        tier: tier ?? (fence.kind === 'tier-fence' ? fence.tier : 'T3'),
        advisoryPrior: fence.kind === 'tier-fence' ? fence.advisoryPrior : undefined,
        markers: screen.hits,
        effectiveTier: stages.effectiveTier,
        wrapperFloorApplied: stages.wrapperFloorApplied,
        explicitAdversarialWrapper: Boolean(opts.explicitAdversarialWrapper),
      };
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    receipt,
    screen,
    fence,
    stages,
  };
}

export function formatTierGatePassMessage(result: TierGateGuardResult): string {
  if (!result.receipt) {
    return 'tier-gate guard: PASS';
  }
  if (result.receipt.kind === 'no-tier') {
    return `tier-gate guard: PASS (receipt=no-tier skip-line markers=${result.receipt.markers.length})`;
  }
  const wrapperNote = result.receipt.wrapperFloorApplied ? ' wrapper-floor=T2' : '';
  return `tier-gate guard: PASS (receipt=tier-fence tier=${result.receipt.tier}${wrapperNote} markers=${result.receipt.markers.length})`;
}
