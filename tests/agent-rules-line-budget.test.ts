import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRulesPath = path.join(repoRoot, 'prompts/agent_rules.md');
const maxLines = 450;

describe('agent rules line budget', () => {
  it('keeps prompts/agent_rules.md at or below the CI ceiling', () => {
    const text = readFileSync(agentRulesPath, 'utf8');
    const lineCount = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(maxLines);
  });
});
