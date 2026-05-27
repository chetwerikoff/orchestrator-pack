import type { LedgerCost, CostSource } from './types.js';

/** Documented AO AgentSessionInfo.cost — accepts AO camelCase and ledger snake_case. */
export interface AgentSessionCost {
  input_tokens?: number | null;
  output_tokens?: number | null;
  estimated_cost_usd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
}

/** Documented AO AgentSessionInfo subset used for chain and cost attribution. */
export interface AgentSessionInfo {
  id?: string;
  agentSessionId?: string;
  parent_session_id?: string | null;
  parentSessionId?: string | null;
  chain_id?: string;
  chainId?: string;
  task_id?: string;
  taskId?: string;
  cost?: AgentSessionCost;
}

function readField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number | null {
  const snake = snakeKey in record ? toNullableNumber(record[snakeKey]) : null;
  const camel = camelKey in record ? toNullableNumber(record[camelKey]) : null;
  return snake ?? camel;
}

function readStringField(
  info: AgentSessionInfo,
  snakeKey: keyof AgentSessionInfo,
  camelKey: keyof AgentSessionInfo,
): string | undefined {
  const raw = info as Record<string, unknown>;
  const snake = raw[snakeKey as string];
  if (typeof snake === 'string' && snake.trim()) {
    return snake.trim();
  }
  const camel = raw[camelKey as string];
  if (typeof camel === 'string' && camel.trim()) {
    return camel.trim();
  }
  return undefined;
}

export function sessionIdFromSessionInfo(info: AgentSessionInfo | null): string | null {
  if (!info) {
    return null;
  }
  const raw = info as Record<string, unknown>;
  for (const key of ['agentSessionId', 'id']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function parentSessionIdFromSessionInfo(info: AgentSessionInfo | null): string | null {
  if (!info) {
    return null;
  }
  return (
    readStringField(info, 'parent_session_id', 'parentSessionId') ??
    null
  );
}

export function chainIdFromSessionInfo(info: AgentSessionInfo | null): string | undefined {
  if (!info) {
    return undefined;
  }
  return readStringField(info, 'chain_id', 'chainId');
}

export function taskIdFromSessionInfo(info: AgentSessionInfo | null): string | undefined {
  if (!info) {
    return undefined;
  }
  return readStringField(info, 'task_id', 'taskId');
}

const TOKEN_LINE =
  /(?:input[_\s-]?tokens?|prompt[_\s-]?tokens?)\s*[:=]\s*(\d+(?:\.\d+)?)/i;
const OUTPUT_LINE =
  /(?:output[_\s-]?tokens?|completion[_\s-]?tokens?)\s*[:=]\s*(\d+(?:\.\d+)?)/i;
const COST_LINE =
  /(?:(?:estimated[_\s-]?)?cost(?:\s*\(usd\))?|total[_\s-]?cost)\s*[:=]\s*\$?(\d+(?:\.\d+)?)/i;
const COMBINED_TOKENS =
  /tokens?\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:in|input)\s*[/,]\s*(\d+(?:\.\d+)?)\s*(?:out|output)/i;

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function unavailableCost(): LedgerCost {
  return {
    input_tokens: null,
    output_tokens: null,
    estimated_cost_usd: null,
    source: 'unavailable',
  };
}

export function readSessionInfoFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentSessionInfo | null {
  const raw = env.AO_SESSION_INFO_JSON?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as AgentSessionInfo;
  } catch {
    return null;
  }
}

export function costFromSessionInfo(info: AgentSessionInfo | null): LedgerCost {
  if (!info?.cost) {
    return unavailableCost();
  }
  const costRecord = info.cost as Record<string, unknown>;
  const input = readField(costRecord, 'input_tokens', 'inputTokens');
  const output = readField(costRecord, 'output_tokens', 'outputTokens');
  const usd = readField(costRecord, 'estimated_cost_usd', 'estimatedCostUsd');
  if (input === null && output === null && usd === null) {
    return unavailableCost();
  }
  return {
    input_tokens: input,
    output_tokens: output,
    estimated_cost_usd: usd,
    source: 'ao-session-cost',
  };
}

export function parseAgentOutputCost(stdout: string): LedgerCost {
  if (!stdout.trim()) {
    return unavailableCost();
  }

  let input: number | null = null;
  let output: number | null = null;
  let usd: number | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const combined = line.match(COMBINED_TOKENS);
    if (combined) {
      input = toNullableNumber(combined[1]);
      output = toNullableNumber(combined[2]);
      continue;
    }
    const inMatch = line.match(TOKEN_LINE);
    if (inMatch) {
      input = toNullableNumber(inMatch[1]);
    }
    const outMatch = line.match(OUTPUT_LINE);
    if (outMatch) {
      output = toNullableNumber(outMatch[1]);
    }
    const costMatch = line.match(COST_LINE);
    if (costMatch) {
      usd = toNullableNumber(costMatch[1]);
    }
  }

  if (input === null && output === null && usd === null) {
    return unavailableCost();
  }

  return {
    input_tokens: input,
    output_tokens: output,
    estimated_cost_usd: usd,
    source: 'agent-output-parse',
  };
}

export function manualImportCost(cost: Partial<AgentSessionCost>): LedgerCost {
  const costRecord = cost as Record<string, unknown>;
  const input = readField(costRecord, 'input_tokens', 'inputTokens');
  const output = readField(costRecord, 'output_tokens', 'outputTokens');
  const usd = readField(costRecord, 'estimated_cost_usd', 'estimatedCostUsd');
  if (input === null && output === null && usd === null) {
    return unavailableCost();
  }
  return {
    input_tokens: input,
    output_tokens: output,
    estimated_cost_usd: usd,
    source: 'manual-import',
  };
}

/** Event kinds that may auto-resolve AO session / parsed stdout cost. */
export const SESSION_COST_EVENT_KINDS = new Set(['finished', 'cost-observed']);

export function eventKindAcceptsSessionCost(eventKind: string): boolean {
  return SESSION_COST_EVENT_KINDS.has(eventKind);
}

export function resolveCostForEvent(
  eventKind: string,
  options: {
    sessionInfo?: AgentSessionInfo | null;
    agentStdout?: string;
    manual?: Partial<AgentSessionCost>;
    explicit?: LedgerCost;
  },
): LedgerCost {
  if (options.explicit) {
    return options.explicit;
  }
  if (options.manual) {
    const manual = manualImportCost(options.manual);
    if (manual.source !== 'unavailable') {
      return manual;
    }
  }
  if (!eventKindAcceptsSessionCost(eventKind)) {
    return unavailableCost();
  }
  return resolveCost(options);
}

export function resolveCost(options: {
  sessionInfo?: AgentSessionInfo | null;
  agentStdout?: string;
  manual?: Partial<AgentSessionCost>;
  explicit?: LedgerCost;
}): LedgerCost {
  if (options.explicit) {
    return options.explicit;
  }
  if (options.manual) {
    const manual = manualImportCost(options.manual);
    if (manual.source !== 'unavailable') {
      return manual;
    }
  }
  const fromSession = costFromSessionInfo(options.sessionInfo ?? null);
  if (fromSession.source !== 'unavailable') {
    return fromSession;
  }
  if (options.agentStdout) {
    const parsed = parseAgentOutputCost(options.agentStdout);
    if (parsed.source !== 'unavailable') {
      return parsed;
    }
  }
  return unavailableCost();
}
