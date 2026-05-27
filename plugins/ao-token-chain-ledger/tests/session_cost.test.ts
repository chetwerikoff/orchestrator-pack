import { describe, expect, it } from 'vitest';
import {
  costFromSessionInfo,
  parseAgentOutputCost,
  resolveCost,
  unavailableCost,
} from '../lib/session_cost.js';

describe('session_cost', () => {
  it('returns unavailable when AO session cost is missing', () => {
    expect(costFromSessionInfo(null)).toEqual(unavailableCost());
    expect(costFromSessionInfo({ cost: {} })).toEqual(unavailableCost());
  });

  it('reads documented AgentSessionInfo.cost fields', () => {
    expect(
      costFromSessionInfo({
        cost: {
          input_tokens: 10,
          output_tokens: 5,
          estimated_cost_usd: 0.01,
        },
      }),
    ).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      estimated_cost_usd: 0.01,
      source: 'ao-session-cost',
    });
  });

  it('parses known cost lines from agent stdout', () => {
    const parsed = parseAgentOutputCost(
      'Run complete\ninput_tokens: 42\noutput_tokens: 21\nestimated_cost: 0.42\n',
    );
    expect(parsed.source).toBe('agent-output-parse');
    expect(parsed.input_tokens).toBe(42);
    expect(parsed.output_tokens).toBe(21);
    expect(parsed.estimated_cost_usd).toBe(0.42);
  });

  it('prefers ao-session-cost over agent-output-parse', () => {
    const resolved = resolveCost({
      sessionInfo: { cost: { input_tokens: 1, output_tokens: 2, estimated_cost_usd: 0.1 } },
      agentStdout: 'input_tokens: 99',
    });
    expect(resolved.source).toBe('ao-session-cost');
    expect(resolved.input_tokens).toBe(1);
  });
});
