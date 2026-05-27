import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { withFindingSignature } from './finding_signature.js';
import {
  chainIdFromSessionInfo,
  parentSessionIdFromSessionInfo,
  readSessionInfoFromEnv,
  resolveCostForEvent,
  sessionIdFromSessionInfo,
  taskIdFromSessionInfo,
  unavailableCost,
  type AgentSessionInfo,
} from './session_cost.js';
import type {
  ChainIdSource,
  LedgerCost,
  LedgerRow,
  ParentSessionIdSource,
  StructuredFinding,
} from './types.js';

export type { LedgerRow, LedgerCost, StructuredFinding } from './types.js';

const RECOGNIZED_EVENT_KINDS = new Set([
  'started',
  'finished',
  'finding',
  'reaction',
  'escalation',
  'cost-observed',
]);

const ACTIVE_CHAIN_FILENAME = 'active-chain.json';
const LEDGER_FILENAME = 'events.jsonl';

export interface ActiveChainState {
  chain_id: string;
  chain_id_source: ChainIdSource;
  created_at: string;
}

export interface ResolveChainIdOptions {
  repoRoot: string;
  issueNumber?: number;
  prNumber?: number;
  manualChainId?: string;
  env?: NodeJS.ProcessEnv;
  sessionInfo?: AgentSessionInfo | null;
}

export interface AppendLedgerOptions {
  repoRoot: string;
  ledgerPath?: string;
}

export interface PrepareRowOptions {
  repoRoot: string;
  issueNumber?: number;
  prNumber?: number;
  env?: NodeJS.ProcessEnv;
  sessionInfo?: AgentSessionInfo | null;
  agentStdout?: string;
}

function ledgerDir(repoRoot: string): string {
  return join(repoRoot, '.ao', 'ledger');
}

export function defaultLedgerPath(repoRoot: string): string {
  return join(ledgerDir(repoRoot), LEDGER_FILENAME);
}

function activeChainPath(repoRoot: string): string {
  return join(ledgerDir(repoRoot), ACTIVE_CHAIN_FILENAME);
}

function readActiveChain(repoRoot: string): ActiveChainState | null {
  try {
    const raw = readFileSync(activeChainPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as ActiveChainState;
    if (parsed?.chain_id && parsed.chain_id_source) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function persistActiveChain(repoRoot: string, state: ActiveChainState): void {
  const dir = ledgerDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(activeChainPath(repoRoot), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function generateWrapperChainId(): { chain_id: string; created_at: string } {
  const created_at = new Date().toISOString();
  const shortUuid = randomBytes(4).toString('hex');
  const stamp = created_at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return {
    chain_id: `chain-${stamp}-${shortUuid}`,
    created_at,
  };
}

export function resolveChainId(options: ResolveChainIdOptions): {
  chain_id: string;
  chain_id_source: ChainIdSource;
} {
  const env = options.env ?? process.env;
  const sessionInfo = options.sessionInfo ?? readSessionInfoFromEnv(env);

  if (options.manualChainId?.trim()) {
    return { chain_id: options.manualChainId.trim(), chain_id_source: 'manual' };
  }

  const explicit = env.AO_CHAIN_ID?.trim();
  if (explicit) {
    return { chain_id: explicit, chain_id_source: 'manual' };
  }

  const aoChain =
    chainIdFromSessionInfo(sessionInfo ?? null) ||
    env.AO_TASK_CHAIN_ID?.trim() ||
    env.AO_CHAIN_TASK_ID?.trim() ||
    taskIdFromSessionInfo(sessionInfo ?? null) ||
    env.AO_TASK_ID?.trim();
  if (aoChain) {
    return { chain_id: aoChain, chain_id_source: 'ao' };
  }

  if (options.issueNumber !== undefined && Number.isFinite(options.issueNumber)) {
    return {
      chain_id: `issue-${options.issueNumber}`,
      chain_id_source: 'issue',
    };
  }

  if (options.prNumber !== undefined && Number.isFinite(options.prNumber)) {
    return {
      chain_id: `pr-${options.prNumber}`,
      chain_id_source: 'pr',
    };
  }

  const existing = readActiveChain(options.repoRoot);
  if (existing) {
    return {
      chain_id: existing.chain_id,
      chain_id_source: existing.chain_id_source,
    };
  }

  const generated = generateWrapperChainId();
  const state: ActiveChainState = {
    chain_id: generated.chain_id,
    chain_id_source: 'wrapper_generated',
    created_at: generated.created_at,
  };
  persistActiveChain(options.repoRoot, state);
  return {
    chain_id: state.chain_id,
    chain_id_source: state.chain_id_source,
  };
}

export function normalizeParentSession(
  parentSessionId?: string | null,
  source?: ParentSessionIdSource,
): {
  parent_session_id: string | null;
  parent_session_id_source: ParentSessionIdSource;
} {
  if (parentSessionId?.trim()) {
    return {
      parent_session_id: parentSessionId.trim(),
      parent_session_id_source: source ?? 'manual',
    };
  }
  return {
    parent_session_id: null,
    parent_session_id_source: 'unavailable',
  };
}

export function isRecognizedEventKind(eventKind: string): boolean {
  return RECOGNIZED_EVENT_KINDS.has(eventKind);
}

export function prepareLedgerRow(
  partial: Partial<LedgerRow> &
    Pick<LedgerRow, 'event_kind' | 'role' | 'task_id'> & {
      repoRoot: string;
      issueNumber?: number;
      prNumber?: number;
    },
  options?: PrepareRowOptions,
): LedgerRow {
  const repoRoot = partial.repoRoot;
  const env = options?.env ?? process.env;
  const sessionInfo = options?.sessionInfo ?? readSessionInfoFromEnv(env);
  const chain = resolveChainId({
    repoRoot,
    issueNumber: partial.issueNumber ?? options?.issueNumber,
    prNumber: partial.prNumber ?? options?.prNumber,
    env,
    sessionInfo,
    manualChainId: partial.chain_id,
  });

  const parent = normalizeParentSession(
    partial.parent_session_id ??
      parentSessionIdFromSessionInfo(sessionInfo) ??
      env.AO_PARENT_SESSION_ID ??
      null,
    partial.parent_session_id_source,
  );

  let finding = partial.finding ?? null;
  if (finding) {
    finding = withFindingSignature(finding);
  }

  const cost =
    partial.cost ??
    resolveCostForEvent(partial.event_kind, {
      sessionInfo,
      agentStdout: options?.agentStdout,
    });

  return {
    chain_id: partial.chain_id ?? chain.chain_id,
    chain_id_source: partial.chain_id_source ?? chain.chain_id_source,
    iteration_id: partial.iteration_id ?? env.AO_ITERATION_ID ?? null,
    session_id:
      partial.session_id ??
      sessionIdFromSessionInfo(sessionInfo) ??
      env.AO_SESSION_ID?.trim() ??
      null,
    parent_session_id: parent.parent_session_id,
    parent_session_id_source: parent.parent_session_id_source,
    task_id: partial.task_id,
    event_kind: partial.event_kind,
    role: partial.role,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    finding,
    reaction: partial.reaction ?? null,
    cost: cost.source === 'unavailable' ? unavailableCost() : cost,
  };
}

export function appendLedgerRow(row: LedgerRow, options: AppendLedgerOptions): void {
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath(options.repoRoot);
  const dir = join(ledgerPath, '..');
  mkdirSync(dir, { recursive: true });

  let output = { ...row };
  if (output.finding) {
    output = {
      ...output,
      finding: withFindingSignature(output.finding),
    };
  }

  appendFileSync(ledgerPath, `${JSON.stringify(output)}\n`, 'utf8');
}

export function readLedgerRows(ledgerPath: string): LedgerRow[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }

  const rows: LedgerRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as LedgerRow);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}
