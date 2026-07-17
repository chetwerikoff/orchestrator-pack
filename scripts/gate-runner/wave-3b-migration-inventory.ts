import { createHash } from 'node:crypto';

export const WAVE_3B_MIGRATION_INVENTORY_PATH = 'scripts/gate-runner/census/wave-3b-migration-inventory.json';
export const EXPECTED_WAVE_3B_MIGRATION_INVENTORY_DIGEST = '991f53519806ca0a1cbe7c323cb05345108a6e80444a2bc80071dcc1e75ddbc3';

export type Wave3bReplacement =
  | { readonly kind: 'registered-gate'; readonly gateIds: readonly string[] }
  | { readonly kind: 'standalone-owner'; readonly ownerId: string; readonly gateIds: readonly string[] }
  | { readonly kind: 'required-file-rule'; readonly gateId: string; readonly path: string }
  | { readonly kind: 'contract-marker-rule'; readonly gateId: string; readonly path: string; readonly markers: readonly string[] }
  | { readonly kind: 'prompt-glob-rule'; readonly gateId: string; readonly pattern: string };

export interface Wave3bMigrationInventoryEntry {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourcePath: string;
  readonly marker: string;
  readonly classification: string;
  readonly gateIds: readonly string[];
  readonly portedInWave: '3.b';
  readonly replacement: Wave3bReplacement;
}

export interface Wave3bMigrationInventory {
  readonly version: 1;
  readonly issue: 841;
  readonly baseCommitSha: string;
  readonly entries: readonly Wave3bMigrationInventoryEntry[];
}

export interface CensusOwnershipEntry {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourcePath: string;
  readonly marker: string;
  readonly classification: string;
  readonly gateIds?: readonly string[];
  readonly portedInWave?: string;
}

export interface Wave3bReplacementSurface {
  readonly requiredFiles: readonly string[];
  readonly contractMarkers: Readonly<Record<string, readonly string[]>>;
  readonly promptGlob: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: readonly string[] = []): string[] {
  return [...values].sort(compareOrdinal);
}

function canonicalReplacement(replacement: Wave3bReplacement): object {
  switch (replacement.kind) {
    case 'registered-gate':
      return { kind: replacement.kind, gateIds: sorted(replacement.gateIds) };
    case 'standalone-owner':
      return { kind: replacement.kind, ownerId: replacement.ownerId, gateIds: sorted(replacement.gateIds) };
    case 'required-file-rule':
      return { kind: replacement.kind, gateId: replacement.gateId, path: replacement.path };
    case 'contract-marker-rule':
      return {
        kind: replacement.kind,
        gateId: replacement.gateId,
        path: replacement.path,
        markers: sorted(replacement.markers),
      };
    case 'prompt-glob-rule':
      return { kind: replacement.kind, gateId: replacement.gateId, pattern: replacement.pattern };
  }
}

export function wave3bMigrationInventoryDigest(inventory: Wave3bMigrationInventory): string {
  const header = JSON.stringify({
    version: inventory.version,
    issue: inventory.issue,
    baseCommitSha: inventory.baseCommitSha,
  });
  const rows = [...inventory.entries]
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((entry) => JSON.stringify({
      id: entry.id,
      sourceKind: entry.sourceKind,
      sourcePath: entry.sourcePath,
      marker: entry.marker,
      classification: entry.classification,
      gateIds: sorted(entry.gateIds),
      portedInWave: entry.portedInWave,
      replacement: canonicalReplacement(entry.replacement),
    }))
    .join('\n');
  return sha256(`${header}\n${rows}\n`);
}

export function parseWave3bMigrationInventory(text: string): Wave3bMigrationInventory {
  const parsed = JSON.parse(text) as Wave3bMigrationInventory;
  if (parsed.version !== 1 || parsed.issue !== 841 || !/^[0-9a-f]{40}$/u.test(parsed.baseCommitSha)) {
    throw new Error('invalid Wave 3.b migration inventory header');
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error('Wave 3.b migration inventory has no entries');
  }
  return parsed;
}

function sameStrings(left: readonly string[] = [], right: readonly string[] = []): boolean {
  return sorted(left).join('\0') === sorted(right).join('\0');
}

export function validateWave3bMigrationInventory(
  inventory: Wave3bMigrationInventory,
  censusEntries: readonly CensusOwnershipEntry[],
  registeredGateIds: ReadonlySet<string>,
  surface: Wave3bReplacementSurface,
): string[] {
  const failures: string[] = [];
  const digest = wave3bMigrationInventoryDigest(inventory);
  if (digest !== EXPECTED_WAVE_3B_MIGRATION_INVENTORY_DIGEST) {
    failures.push(`Wave 3.b migration inventory digest drift: expected=${EXPECTED_WAVE_3B_MIGRATION_INVENTORY_DIGEST} actual=${digest}`);
  }

  const inventoryById = new Map<string, Wave3bMigrationInventoryEntry>();
  for (const entry of inventory.entries) {
    if (inventoryById.has(entry.id)) failures.push(`duplicate Wave 3.b migration inventory id: ${entry.id}`);
    inventoryById.set(entry.id, entry);
  }
  const censusById = new Map(censusEntries.map((entry) => [entry.id, entry] as const));
  for (const entry of inventory.entries) {
    const census = censusById.get(entry.id);
    if (!census) {
      failures.push(`${entry.id}: frozen Wave 3.b ownership row is missing from census`);
      continue;
    }
    if (census.sourceKind !== entry.sourceKind || census.sourcePath !== entry.sourcePath || census.marker !== entry.marker) {
      failures.push(`${entry.id}: frozen Wave 3.b source identity drifted`);
    }
    if (census.classification !== entry.classification
      || census.portedInWave !== entry.portedInWave
      || !sameStrings(census.gateIds, entry.gateIds)) {
      failures.push(`${entry.id}: frozen Wave 3.b classification/gate ownership drifted`);
    }

    for (const gateId of entry.gateIds) {
      if (!registeredGateIds.has(gateId)) failures.push(`${entry.id}: replacement gate is not registered: ${gateId}`);
    }

    const replacement = entry.replacement;
    switch (replacement.kind) {
      case 'registered-gate':
        if (!sameStrings(replacement.gateIds, entry.gateIds)) {
          failures.push(`${entry.id}: registered-gate replacement does not bind every owned gateId`);
        }
        break;
      case 'standalone-owner': {
        const owner = inventoryById.get(replacement.ownerId);
        if (!owner || owner.sourceKind !== 'check-script') {
          failures.push(`${entry.id}: standalone replacement owner is missing: ${replacement.ownerId}`);
        } else {
          if (owner.sourcePath !== entry.marker) failures.push(`${entry.id}: standalone replacement owner path drifted`);
          if (!sameStrings(owner.gateIds, entry.gateIds) || !sameStrings(replacement.gateIds, entry.gateIds)) {
            failures.push(`${entry.id}: standalone replacement owner does not bind every gateId`);
          }
        }
        break;
      }
      case 'required-file-rule':
        if (replacement.gateId !== 'verify-required-files' || !entry.gateIds.includes(replacement.gateId)) {
          failures.push(`${entry.id}: required-file replacement gate binding drifted`);
        }
        if (replacement.path !== entry.marker || !surface.requiredFiles.includes(replacement.path)) {
          failures.push(`${entry.id}: required-file replacement rule is missing for ${replacement.path}`);
        }
        break;
      case 'contract-marker-rule': {
        if (replacement.gateId !== 'verify-structure-contract' || !entry.gateIds.includes(replacement.gateId)) {
          failures.push(`${entry.id}: contract-marker replacement gate binding drifted`);
        }
        if (entry.marker !== `Test-ContractMarkers '${replacement.path}'`) {
          failures.push(`${entry.id}: contract-marker source identity drifted`);
        }
        const liveMarkers = surface.contractMarkers[replacement.path] ?? [];
        for (const marker of replacement.markers) {
          if (!liveMarkers.includes(marker)) failures.push(`${entry.id}: concrete replacement marker is missing: ${marker}`);
        }
        break;
      }
      case 'prompt-glob-rule':
        if (replacement.gateId !== 'verify-structure-contract' || !entry.gateIds.includes(replacement.gateId)) {
          failures.push(`${entry.id}: prompt-glob replacement gate binding drifted`);
        }
        if (entry.marker !== replacement.pattern || surface.promptGlob !== replacement.pattern) {
          failures.push(`${entry.id}: prompt-glob replacement rule drifted`);
        }
        break;
    }
  }

  for (const entry of censusEntries) {
    if (entry.portedInWave === '3.b' && !inventoryById.has(entry.id)) {
      failures.push(`${entry.id}: census claims Wave 3.b ownership outside the frozen migration inventory`);
    }
  }
  return failures;
}
