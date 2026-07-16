import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadFleetLivenessContract,
  type FleetLivenessChildContract,
  type FleetLivenessContractDocument,
} from '../kernel/side-process-liveness.ts';

export interface SideProcessRegistryChild {
  readonly id: string;
  readonly script: string;
  readonly cadenceSeconds: number;
  readonly stallGraceMultiplier?: number;
}

export interface SideProcessRegistryDocument {
  readonly schemaVersion: number;
  readonly requiredChildIds: readonly string[];
  readonly children: readonly SideProcessRegistryChild[];
}

export interface FleetLivenessCensusFinding {
  readonly childId: string;
  readonly code: string;
  readonly message: string;
}

export interface FleetLivenessCensusOptions {
  readonly repoRoot: string;
  readonly registry?: SideProcessRegistryDocument;
  readonly contract?: FleetLivenessContractDocument;
  readonly sourceLoader?: (repoRelativePath: string) => string | null;
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function defaultSourceLoader(repoRoot: string): (repoRelativePath: string) => string | null {
  return (repoRelativePath) => {
    const path = resolve(repoRoot, repoRelativePath);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  };
}

function addFinding(
  findings: FleetLivenessCensusFinding[],
  childId: string,
  code: string,
  message: string,
): void {
  findings.push({ childId, code, message });
}

function effectiveStallThresholdMs(child: SideProcessRegistryChild): number {
  const cadenceSeconds = positiveInteger(child.cadenceSeconds);
  const grace = Math.max(2, positiveInteger(child.stallGraceMultiplier) || 2);
  return cadenceSeconds * grace * 1_000;
}

function childContractMap(
  contract: FleetLivenessContractDocument,
  findings: FleetLivenessCensusFinding[],
): Map<string, FleetLivenessChildContract> {
  const map = new Map<string, FleetLivenessChildContract>();
  for (const child of contract.children) {
    if (!child.id) {
      addFinding(findings, '<contract>', 'contract_child_id_missing', 'contract child entry is missing id');
      continue;
    }
    if (map.has(child.id)) {
      addFinding(findings, child.id, 'duplicate_contract_child', `duplicate liveness contract entry for ${child.id}`);
      continue;
    }
    map.set(child.id, child);
  }
  return map;
}

function validateSharedTransports(
  options: FleetLivenessCensusOptions,
  contract: FleetLivenessContractDocument,
  findings: FleetLivenessCensusFinding[],
  loadSource: (repoRelativePath: string) => string | null,
): void {
  const required = ['gh', 'ao', 'terminalOutcome', 'runtime'];
  for (const key of required) {
    const path = contract.sharedTransports?.[key];
    if (!path) {
      addFinding(findings, '<fleet>', 'shared_transport_missing', `shared transport ${key} is not declared`);
      continue;
    }
    const source = loadSource(path);
    if (source === null) {
      addFinding(findings, '<fleet>', 'shared_transport_path_missing', `shared transport ${key} path missing: ${path}`);
      continue;
    }
    if (key !== 'runtime' && !source.includes('side-process-liveness.ts')) {
      addFinding(
        findings,
        '<fleet>',
        'shared_transport_not_wired',
        `shared transport ${key} does not dispatch to side-process-liveness.ts: ${path}`,
      );
    }
  }

  const terminalPath = contract.sharedTransports?.terminalOutcome;
  if (terminalPath) {
    const terminalSource = loadSource(terminalPath) ?? '';
    if (!terminalSource.includes('consume-timeout')) {
      addFinding(
        findings,
        '<fleet>',
        'timeout_terminal_route_missing',
        `terminal outcome transport does not consume bounded timeouts: ${terminalPath}`,
      );
    }
  }
}

function validateWiredChild(
  child: SideProcessRegistryChild,
  declaration: FleetLivenessChildContract,
  findings: FleetLivenessCensusFinding[],
  loadSource: (repoRelativePath: string) => string | null,
): void {
  const thresholdMs = effectiveStallThresholdMs(child);
  const maxBudgetMs = Math.floor(thresholdMs / 2);
  const callKinds = new Set(declaration.externalCallKinds ?? []);
  for (const requiredCallKind of ['gh', 'ao']) {
    if (!callKinds.has(requiredCallKind)) {
      addFinding(
        findings,
        child.id,
        'external_call_kind_missing',
        `${child.id} is not wired for external call kind ${requiredCallKind}`,
      );
    }
  }
  const timeoutMs = positiveInteger(declaration.maxExternalCallTimeoutMs);
  if (timeoutMs <= 0) {
    addFinding(
      findings,
      child.id,
      'external_timeout_missing',
      `${child.id} has no positive maxExternalCallTimeoutMs (stallThresholdMs=${thresholdMs})`,
    );
  } else if (timeoutMs > maxBudgetMs) {
    addFinding(
      findings,
      child.id,
      'external_timeout_exceeds_half_stall',
      `${child.id} call=gh/ao timeout ${timeoutMs}ms exceeds 50% stall budget ${maxBudgetMs}ms (marginMs=${maxBudgetMs - timeoutMs})`,
    );
  }

  const localGapMs = positiveInteger(declaration.maxLocalComputeGapMs);
  if (localGapMs <= 0) {
    addFinding(
      findings,
      child.id,
      'local_progress_bound_missing',
      `${child.id} has no positive maxLocalComputeGapMs`,
    );
  } else if (localGapMs > maxBudgetMs) {
    addFinding(
      findings,
      child.id,
      'local_progress_gap_exceeds_half_stall',
      `${child.id} local progress gap ${localGapMs}ms exceeds 50% stall budget ${maxBudgetMs}ms (marginMs=${maxBudgetMs - localGapMs})`,
    );
  }

  if (!declaration.localProgressMode) {
    addFinding(findings, child.id, 'local_progress_mode_missing', `${child.id} has no localProgressMode`);
  }
  if (!declaration.evidence || declaration.evidence.length === 0) {
    addFinding(findings, child.id, 'coverage_evidence_missing', `${child.id} has no liveness evidence paths`);
  } else {
    for (const evidencePath of declaration.evidence) {
      if (loadSource(evidencePath) === null) {
        addFinding(
          findings,
          child.id,
          'coverage_evidence_path_missing',
          `${child.id} liveness evidence path missing: ${evidencePath}`,
        );
      }
    }
  }

  const childSourcePath = `scripts/${child.script}`;
  const childSource = loadSource(childSourcePath);
  if (childSource === null) {
    addFinding(findings, child.id, 'child_script_missing', `${child.id} script missing: ${childSourcePath}`);
    return;
  }
  for (const terminalHelper of [
    'Write-OrchestratorSideProcessTickSuccess',
    'Write-OrchestratorSideProcessTickError',
  ]) {
    if (!childSource.includes(terminalHelper)) {
      addFinding(
        findings,
        child.id,
        'terminal_helper_missing',
        `${child.id} does not use ${terminalHelper}; bounded timeout cannot enter existing degraded/backoff accounting`,
      );
    }
  }
}

function validateExemptChild(
  child: SideProcessRegistryChild,
  declaration: FleetLivenessChildContract,
  anchors: Set<string>,
  findings: FleetLivenessCensusFinding[],
  loadSource: (repoRelativePath: string) => string | null,
): void {
  if (anchors.has(child.id)) {
    addFinding(findings, child.id, 'regression_anchor_exempt', `${child.id} is a mandatory wired regression anchor`);
  }
  if (!declaration.exemptionReason || declaration.exemptionReason.trim().length < 20) {
    addFinding(
      findings,
      child.id,
      'exemption_reason_insufficient',
      `${child.id} exemption requires a concrete, reviewable reason`,
    );
  }
  if (!declaration.evidence || declaration.evidence.length === 0) {
    addFinding(findings, child.id, 'exemption_evidence_missing', `${child.id} exemption has no evidence`);
    return;
  }
  for (const evidencePath of declaration.evidence) {
    if (loadSource(evidencePath) === null) {
      addFinding(
        findings,
        child.id,
        'exemption_evidence_path_missing',
        `${child.id} exemption evidence path missing: ${evidencePath}`,
      );
    }
  }
}

export function validateFleetLivenessCensus(
  options: FleetLivenessCensusOptions,
): FleetLivenessCensusFinding[] {
  const findings: FleetLivenessCensusFinding[] = [];
  const registry = options.registry ?? JSON.parse(
    readFileSync(resolve(options.repoRoot, 'scripts/orchestrator-side-process-registry.json'), 'utf8'),
  ) as SideProcessRegistryDocument;
  const contract = options.contract ?? loadFleetLivenessContract(
    resolve(options.repoRoot, 'scripts/orchestrator-side-process-liveness-contract.json'),
  );
  const loadSource = options.sourceLoader ?? defaultSourceLoader(options.repoRoot);

  if (contract.schemaVersion !== 1) {
    addFinding(findings, '<contract>', 'unsupported_contract_schema', `unsupported liveness contract schema ${contract.schemaVersion}`);
  }
  validateSharedTransports(options, contract, findings, loadSource);

  const anchors = new Set(contract.regressionAnchors);
  for (const requiredAnchor of ['review-ready-report-state-seed', 'review-trigger-reeval']) {
    if (!anchors.has(requiredAnchor)) {
      addFinding(findings, requiredAnchor, 'regression_anchor_missing', `mandatory regression anchor is not declared: ${requiredAnchor}`);
    }
  }

  const declarations = childContractMap(contract, findings);
  const registryIds = new Set<string>();
  const requiredIds = new Set(registry.requiredChildIds ?? []);
  for (const child of registry.children ?? []) {
    if (!child.id) {
      addFinding(findings, '<registry>', 'registry_child_id_missing', 'registry child is missing id');
      continue;
    }
    if (registryIds.has(child.id)) {
      addFinding(findings, child.id, 'duplicate_registry_child', `duplicate registry child ${child.id}`);
      continue;
    }
    registryIds.add(child.id);
    if (!requiredIds.has(child.id)) {
      addFinding(findings, child.id, 'registry_required_id_missing', `${child.id} is not listed in requiredChildIds`);
    }
    const declaration = declarations.get(child.id);
    if (!declaration) {
      addFinding(
        findings,
        child.id,
        'unaccounted_registry_child',
        `${child.id} has no wired contract or reviewed exemption`,
      );
      continue;
    }
    if (declaration.mode === 'wired') {
      validateWiredChild(child, declaration, findings, loadSource);
    } else if (declaration.mode === 'exempt') {
      validateExemptChild(child, declaration, anchors, findings, loadSource);
    } else {
      addFinding(findings, child.id, 'invalid_contract_mode', `${child.id} has invalid liveness mode`);
    }
  }

  for (const requiredId of requiredIds) {
    if (!registryIds.has(requiredId)) {
      addFinding(findings, requiredId, 'required_registry_child_missing', `required child missing from registry: ${requiredId}`);
    }
  }
  for (const declaration of contract.children) {
    if (!registryIds.has(declaration.id)) {
      addFinding(
        findings,
        declaration.id,
        'stale_contract_child',
        `liveness contract entry has no registry child: ${declaration.id}`,
      );
    }
  }

  for (const anchor of anchors) {
    const declaration = declarations.get(anchor);
    if (!declaration || declaration.mode !== 'wired') {
      addFinding(findings, anchor, 'regression_anchor_not_wired', `${anchor} must remain wired`);
    }
  }

  return findings.sort(
    (left, right) => left.childId.localeCompare(right.childId) || left.code.localeCompare(right.code),
  );
}

export function runFleetLivenessCensus(repoRoot: string): FleetLivenessCensusFinding[] {
  return validateFleetLivenessCensus({ repoRoot });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const findings = runFleetLivenessCensus(repoRoot);
  if (findings.length === 0) {
    process.stdout.write('Fleet liveness census passed.\n');
  } else {
    for (const finding of findings) {
      process.stderr.write(`${finding.childId} ${finding.code}: ${finding.message}\n`);
    }
    process.exitCode = 1;
  }
}
