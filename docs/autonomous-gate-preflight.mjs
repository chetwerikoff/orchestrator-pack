/**
 * Shared autonomous gate preflight helpers (Issues #318 / #384).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

/**
 * @param {object} input
 * @param {object} config
 * @param {string} config.expectedGateVersion
 * @param {string} config.atomicClaimCapability
 * @param {string} config.rawCapabilityId
 * @param {string} config.rawNotUnavailableReason
 * @param {string[]} [config.extraRequiredUnavailable]
 */
export function evaluateAutonomousGatePreflight(input, config) {
  if (input.loadedGateVersion !== config.expectedGateVersion) {
    return {
      ok: false,
      reason: 'gate_preflight_stale_or_missing',
      auditShape: 'preflight_refusal',
      markerState: String(input.loadedGateVersion ?? ''),
    };
  }
  if (input.atomicClaimPresent === false) {
    return {
      ok: false,
      reason: 'atomic_claim_capability_missing',
      auditShape: 'preflight_refusal',
      markerState: config.atomicClaimCapability,
    };
  }
  for (const capability of toArray(input.liveCapabilities)) {
    const classification = String(capability?.classification ?? '').toLowerCase();
    if (!classification || (classification !== 'gated' && classification !== 'unavailable')) {
      return {
        ok: false,
        reason: 'live_capability_unclassified',
        auditShape: 'preflight_refusal',
        markerState: String(capability?.id ?? ''),
      };
    }
  }
  const raw = toArray(input.liveCapabilities).find((row) => row.id === config.rawCapabilityId);
  if (raw && String(raw.classification).toLowerCase() !== 'unavailable') {
    return {
      ok: false,
      reason: config.rawNotUnavailableReason,
      auditShape: 'preflight_refusal',
      markerState: config.rawCapabilityId,
    };
  }
  for (const requiredUnavailable of config.extraRequiredUnavailable ?? []) {
    const row = toArray(input.liveCapabilities).find((cap) => cap.id === requiredUnavailable);
    if (!row || String(row.classification).toLowerCase() !== 'unavailable') {
      return {
        ok: false,
        reason: `${requiredUnavailable}_not_unavailable`,
        auditShape: 'preflight_refusal',
        markerState: requiredUnavailable,
      };
    }
  }
  return { ok: true, reason: 'gate_preflight_ok', auditShape: 'none' };
}

/**
 * @param {object} input
 * @param {Array<{ id: string, classification: string }>} input.repoInventory
 * @param {Array<{ id: string, classification?: string }>} [input.liveSurfaces]
 */
export function validateCapabilityInventory(input) {
  const repoIds = new Set(toArray(input.repoInventory).map((row) => String(row.id)));
  const violations = [];
  for (const row of toArray(input.repoInventory)) {
    const classification = String(row.classification ?? '');
    if (classification !== 'gated' && classification !== 'unavailable') {
      violations.push(`unclassified repo capability: ${row.id}`);
    }
  }
  for (const live of toArray(input.liveSurfaces)) {
    const id = String(live.id ?? '');
    if (!repoIds.has(id)) {
      violations.push(`live capability missing from repo inventory: ${id}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * @param {string} [inventoryPath]
 * @param {string} defaultRelativePath
 */
export function loadAutonomousCapabilitiesInventory(inventoryPath, defaultRelativePath) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolved = inventoryPath ?? path.join(repoRoot, defaultRelativePath);
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

/**
 * @param {object} inventory
 * @param {object} shared
 */
export function mergeAutonomousCapabilitiesInventory(inventory, shared) {
  const byId = new Map();
  for (const row of [...(shared?.capabilities ?? []), ...(inventory?.capabilities ?? [])]) {
    byId.set(String(row.id), row);
  }
  return { ...inventory, capabilities: [...byId.values()] };
}

/**
 * @param {string} [inventoryPath]
 * @param {string} defaultRelativePath
 */
export function loadMergedAutonomousCapabilitiesInventory(inventoryPath, defaultRelativePath) {
  const inventory = loadAutonomousCapabilitiesInventory(inventoryPath, defaultRelativePath);
  const shared = loadAutonomousCapabilitiesInventory(
    undefined,
    'docs/autonomous-shared-capabilities.json',
  );
  return mergeAutonomousCapabilitiesInventory(inventory, shared);
}
