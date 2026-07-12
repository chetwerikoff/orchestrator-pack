#!/usr/bin/env node
/**
 * Weight-driven heavy Vitest shard topology derivation and oversized-file floor guard
 * (Issue #695). Consumes runtime-history per GitHub #691 contract; does not implement
 * the harvest producer.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  defaultRepoRoot,
  discoverVitestFiles,
  loadLanesConfig,
  partitionByLane,
  resolveHeavyRuntimeMs,
  resolveRepoRoot,
  runtimeHistoryPath,
  validateClassification,
  validateParkedWallclockE2e,
} from './vitest-ci-lanes.mjs';
import { resolveVitestPrScopeSelection } from './vitest-pr-scoped-selection.mjs';

/** Canonical CI-generated topology artifact (not committed). */
export const topologyArtifactRelPath = 'scripts/vitest-heavy-topology.plan.json';

export const FALLBACK_CLASSIFICATION = {
  DERIVED: 'derived',
  FIXED_FALLBACK: 'fixed-fallback',
};

/** Per-file provenance values accepted for merge-blocking guard weight resolution (#691 / #695). */
export const FRESH_GUARD_PROVENANCE = new Set(['measured']);

export function artifactRequiresFreshnessProvenance(artifact) {
  if (!artifact) {
    return false;
  }
  if (artifact.source === 'ci-measured') {
    return true;
  }
  return Boolean(
    artifact.provenance
    && typeof artifact.provenance === 'object'
    && !Array.isArray(artifact.provenance)
    && Object.keys(artifact.provenance).length > 0,
  );
}

/**
 * #691 runtime-history artifact shape (consumer-only; producer is #691).
 * Numeric `files` map stays ms; policy math normalizes to seconds at read time.
 */
export function loadRuntimeHistoryArtifact(repoRoot = defaultRepoRoot) {
  const path = runtimeHistoryPath(repoRoot);
  if (!existsSync(path)) {
    return { state: 'absent', path, artifact: null };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      state: 'present_but_unusable',
      reason: `corrupt-json: ${error instanceof Error ? error.message : String(error)}`,
      path,
      artifact: null,
    };
  }

  if (!raw || typeof raw !== 'object') {
    return { state: 'present_but_unusable', reason: 'corrupt-shape', path, artifact: null };
  }

  const files = raw.files ?? {};
  if (typeof files !== 'object' || Array.isArray(files)) {
    return { state: 'present_but_unusable', reason: 'corrupt-files-map', path, artifact: null };
  }

  const fileEntries = Object.entries(files);
  if (fileEntries.length === 0) {
    return { state: 'present_but_unusable', reason: 'empty-files-map', path, artifact: raw };
  }

  let positiveWeightCount = 0;
  for (const [, value] of fileEntries) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) {
      positiveWeightCount += 1;
    }
  }
  if (positiveWeightCount === 0) {
    return { state: 'present_but_unusable', reason: 'degenerate-all-nonpositive', path, artifact: raw };
  }

  return {
    state: 'valid',
    path,
    artifact: {
      source: typeof raw.source === 'string' ? raw.source : undefined,
      files,
      provenance: raw.provenance && typeof raw.provenance === 'object' && !Array.isArray(raw.provenance)
        ? raw.provenance
        : undefined,
      contentSha:
        raw.contentSha && typeof raw.contentSha === 'object' && !Array.isArray(raw.contentSha)
          ? raw.contentSha
          : undefined,
      dataChangedAt: typeof raw.dataChangedAt === 'string' ? raw.dataChangedAt : undefined,
    },
  };
}

export function parseTopologyPolicy(rawConfig) {
  const block = rawConfig.heavyTopology ?? rawConfig;
  return {
    targetShardSeconds: Number(block.targetShardSeconds),
    minShardCount: Number(block.minShardCount),
    maxShardCount: Number(block.maxShardCount),
    fallbackHeavyShardCount: Number(block.fallbackHeavyShardCount ?? block.heavyShardCount ?? 7),
  };
}

export function validateTopologyPolicy(policy) {
  const errors = [];
  if (!Number.isFinite(policy.targetShardSeconds) || policy.targetShardSeconds <= 0) {
    errors.push('heavyTopology.targetShardSeconds must be a positive number (seconds)');
  }
  if (!Number.isFinite(policy.minShardCount) || policy.minShardCount < 1) {
    errors.push('heavyTopology.minShardCount must be >= 1');
  }
  if (!Number.isFinite(policy.maxShardCount) || policy.maxShardCount < policy.minShardCount) {
    errors.push('heavyTopology.maxShardCount must be >= minShardCount');
  }
  if (!Number.isFinite(policy.fallbackHeavyShardCount) || policy.fallbackHeavyShardCount < 1) {
    errors.push('heavyTopology.fallbackHeavyShardCount must be >= 1');
  }
  return errors;
}

export function msToSeconds(ms) {
  return ms / 1000;
}

export function computeFileContentSha(repoRoot, filePath) {
  const root = resolveRepoRoot(repoRoot);
  const absolute = join(root, filePath);
  if (!existsSync(absolute)) {
    return null;
  }
  const bytes = readFileSync(absolute);
  return createHash('sha256').update(bytes).digest('hex');
}

export function resolveGuardWeightSeconds(file, artifact, repoRoot, options = {}) {
  const preTopology = options.preTopologyMeasurements ?? {};
  const changedFiles = new Set(options.changedFiles ?? []);
  if (Object.prototype.hasOwnProperty.call(preTopology, file)) {
    const measuredSeconds = Number(preTopology[file]);
    if (Number.isFinite(measuredSeconds) && measuredSeconds > 0) {
      return { ok: true, weightSeconds: measuredSeconds, source: 'pre-topology-measurement' };
    }
    return { ok: false, reason: 'invalid-pre-topology-measurement', file };
  }

  if (!artifact) {
    return { ok: false, reason: 'missing-runtime-history-artifact', file };
  }

  const rawMs = artifact.files?.[file];
  const hasNumeric = Number.isFinite(Number(rawMs)) && Number(rawMs) > 0;
  const provenance = artifact.provenance?.[file];
  const requiresFreshness = artifactRequiresFreshnessProvenance(artifact);

  if (!hasNumeric) {
    return { ok: false, reason: 'missing-per-file-weight', file };
  }

  if (requiresFreshness) {
    if (!provenance || !FRESH_GUARD_PROVENANCE.has(provenance)) {
      if (provenance === 'fallback') {
        return { ok: false, reason: 'fallback-provenance-not-acceptable-for-guard', file };
      }
      return { ok: false, reason: 'missing-freshness-provenance', file };
    }
  } else if (artifact.provenance && provenance === 'fallback') {
    return { ok: false, reason: 'fallback-provenance-not-acceptable-for-guard', file };
  }

  if (artifact.contentSha) {
    const expected = artifact.contentSha[file];
    if (typeof expected === 'string' && expected.length > 0) {
      const current = computeFileContentSha(repoRoot, file);
      if (!current || current !== expected) {
        return { ok: false, reason: 'stale-content-sha', file };
      }
    }
  }

  if (changedFiles.has(file)) {
    const expectedSha = artifact.contentSha?.[file];
    const hasShaBinding =
      typeof expectedSha === 'string'
      && expectedSha.length > 0
      && computeFileContentSha(repoRoot, file) === expectedSha;
    if (!hasShaBinding) {
      return { ok: false, reason: 'stale-unassociated-weight', file };
    }
  }

  return {
    ok: true,
    weightSeconds: msToSeconds(Number(rawMs)),
    source: provenance ?? 'numeric-files-map',
  };
}

export function findOversizedFiles(discovered, artifact, policy, repoRoot, options = {}) {
  const offenders = [];
  const unresolved = [];
  const changedFiles = new Set(options.changedFiles ?? []);

  const classification = options.classification ?? {};
  const guardDiscoveredFiles = discovered.filter((file) => {
    const lane = classification[file];
    return lane !== 'postMergeWallclock' && lane !== 'parked';
  });
  for (const file of guardDiscoveredFiles) {
    const resolved = resolveGuardWeightSeconds(file, artifact, repoRoot, {
      ...options,
      changedFiles: [...changedFiles],
    });
    if (!resolved.ok) {
      unresolved.push({ file, reason: resolved.reason });
      continue;
    }
    if (resolved.weightSeconds > policy.targetShardSeconds) {
      offenders.push({
        file,
        weightSeconds: resolved.weightSeconds,
        targetShardSeconds: policy.targetShardSeconds,
      });
    }
  }

  return { offenders, unresolved };
}

export function sumHeavyLaneWeightSeconds(heavyFiles, runtimeHistory, defaultRuntimeMs) {
  let totalMs = 0;
  for (const file of heavyFiles) {
    totalMs += resolveHeavyRuntimeMs(file, runtimeHistory, defaultRuntimeMs);
  }
  return msToSeconds(totalMs);
}

export function clampHeavyShardCount(count, policy) {
  return Math.min(Math.max(count, policy.minShardCount), policy.maxShardCount);
}

export function deriveHeavyShardCountFromTotal(heavyLaneTotalSeconds, policy) {
  const raw = Math.ceil(heavyLaneTotalSeconds / policy.targetShardSeconds);
  const clamped = clampHeavyShardCount(raw, policy);
  return {
    heavyShardCount: clamped,
    rawDerivedCount: raw,
    underProvisioned: raw > policy.maxShardCount,
  };
}

export function buildHeavyShardIndices(heavyShardCount) {
  return Array.from({ length: heavyShardCount }, (_, index) => index + 1);
}

export function buildHeavyTopology(repoRoot = defaultRepoRoot, options = {}) {
  const root = resolveRepoRoot(repoRoot);
  const rawConfig = JSON.parse(readFileSync(join(root, 'scripts/vitest-ci-lanes.config.json'), 'utf8'));
  const lanesConfig = loadLanesConfig(root);
  const policy = parseTopologyPolicy(rawConfig);
  const policyErrors = validateTopologyPolicy(policy);
  if (policyErrors.length > 0) {
    return { ok: false, errors: policyErrors };
  }

  const historyLoad = loadRuntimeHistoryArtifact(root);
  if (historyLoad.state === 'absent') {
    return {
      ok: false,
      errors: [
        'runtime-history artifact missing at scripts/vitest-runtime-history.json — post-#691 this signals a broken harvest pipeline (fail-closed; no topology fallback)',
      ],
    };
  }

  const fullDiscovered = discoverVitestFiles(root);
  const classificationErrors = validateClassification(fullDiscovered, lanesConfig.classification);
  if (classificationErrors.length > 0) {
    return { ok: false, errors: classificationErrors, discovered: fullDiscovered };
  }
  const parkedErrors = validateParkedWallclockE2e(lanesConfig.classification, lanesConfig.parkedWallclockE2e);
  if (parkedErrors.length > 0) {
    return { ok: false, errors: parkedErrors, discovered: fullDiscovered };
  }

  const fullLanePlan = partitionByLane(fullDiscovered, lanesConfig.classification);
  const prScope = resolveVitestPrScopeSelection({
    repoRoot: root,
    changedPathManifest: options.changedPathManifest ?? null,
    discoveredTests: fullDiscovered,
    heavyFiles: fullLanePlan.heavy,
    prScopeMode: options.prScopeMode,
  });
  const discovered =
    prScope.applicable && prScope.effectiveRunMode === 'scoped'
      ? [...prScope.selectedHeavyFiles]
      : [...fullDiscovered];
  const { light, heavy, postMergeWallclock, parked } = partitionByLane(discovered, lanesConfig.classification);
  const runtimeHistory = historyLoad.state === 'valid' ? historyLoad.artifact.files : {};
  const heavyLaneTotalWeightSeconds = sumHeavyLaneWeightSeconds(
    heavy,
    runtimeHistory,
    lanesConfig.heavyDefaultRuntimeMs,
  );

  let heavyShardCount;
  let fallbackClassification = FALLBACK_CLASSIFICATION.DERIVED;
  let underProvisioned = false;
  let rawDerivedCount = null;
  let weightInputReason = null;

  if (historyLoad.state === 'present_but_unusable') {
    heavyShardCount = clampHeavyShardCount(policy.fallbackHeavyShardCount, policy);
    fallbackClassification = FALLBACK_CLASSIFICATION.FIXED_FALLBACK;
    weightInputReason = historyLoad.reason;
  } else {
    const derived = deriveHeavyShardCountFromTotal(heavyLaneTotalWeightSeconds, policy);
    heavyShardCount = derived.heavyShardCount;
    underProvisioned = derived.underProvisioned;
    rawDerivedCount = derived.rawDerivedCount;
  }

  const heavyShardIndices = buildHeavyShardIndices(heavyShardCount);
  const artifactForGuard =
    historyLoad.state === 'valid'
      ? historyLoad.artifact
      : historyLoad.state === 'present_but_unusable' && historyLoad.artifact
        ? historyLoad.artifact
        : null;
  const oversized = findOversizedFiles(discovered, artifactForGuard, policy, root, {
    ...options,
    classification: lanesConfig.classification,
  });

  const topology = {
    issue: 732,
    heavyShardCount,
    heavyShardIndices,
    heavyShardMatrix: heavyShardIndices,
    fallbackClassification,
    targetShardSeconds: policy.targetShardSeconds,
    heavyLaneTotalWeightSeconds,
    underProvisioned,
    rawDerivedCount,
    weightInputReason,
    policy,
    parity: {
      count: heavyShardCount,
      matrixLength: heavyShardIndices.length,
    },
    fullDiscoveryCount: fullDiscovered.length,
    prScope,
    oversizedOffenders: oversized.offenders,
    unresolvedGuardWeights: oversized.unresolved,
  };

  return {
    ok: true,
    topology,
    discovered,
    fullDiscovered,
    light,
    heavy,
    postMergeWallclock,
    parked,
    runtimeHistory,
    lanesConfig,
    historyLoad,
    policy,
  };
}

export function topologyArtifactPath(repoRoot = defaultRepoRoot) {
  return join(resolveRepoRoot(repoRoot), topologyArtifactRelPath);
}

export function formatOversizedGuardFailures(topologyResult) {
  const messages = [];
  if (!topologyResult.ok) {
    return messages;
  }
  for (const entry of topologyResult.topology.oversizedOffenders) {
    messages.push(
      `oversized-vitest-file: ${entry.file} resolved ${entry.weightSeconds}s exceeds targetShardSeconds ${entry.targetShardSeconds}s — split the file or speed it up`,
    );
  }
  for (const entry of topologyResult.topology.unresolvedGuardWeights) {
    messages.push(
      `unresolved-vitest-weight: ${entry.file} (${entry.reason}) — add measured runtime history (#691), supply deterministic pre-topology measurement, or refresh contentSha association`,
    );
  }
  return messages;
}

export function relativeRepoPath(repoRoot, absolutePath) {
  return relative(resolveRepoRoot(repoRoot), absolutePath).replace(/\\/g, '/');
}
