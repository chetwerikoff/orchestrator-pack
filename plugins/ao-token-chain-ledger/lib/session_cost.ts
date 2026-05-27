import type { LedgerCost, CostSource } from './types.js';

/** Documented AO AgentSessionInfo.cost subset — upgrade-safe, no AO internals. */
export interface AgentSessionCost {
  input_tokens?: number | null;
  output_tokens?: number | null;
  estimated_cost_usd?: number | null;
}

/** Documented AO AgentSessionInfo subset used for chain and cost attribution. */
export interface AgentSessionInfo {
  id?: string;
  parent_session_id?: string | null;
  chain_id?: string;
  task_id?: string;
  cost?: AgentSessionCost;
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
  const input = toNullableNumber(info.cost.input_tokens);
  const output = toNullableNumber(info.cost.output_tokens);
  const usd = toNullableNumber(info.cost.estimated_cost_usd);
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
  const input = toNullableNumber(cost.input_tokens);
  const output = toNullableNumber(cost.output_tokens);
  const usd = toNullableNumber(cost.estimated_cost_usd);
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
