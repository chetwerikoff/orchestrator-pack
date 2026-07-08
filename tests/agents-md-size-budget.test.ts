import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsMdPath = path.join(repoRoot, 'AGENTS.md');
const maxLines = 450;
const maxBytes = 28672;

describe('AGENTS.md size budget', () => {
  it('keeps AGENTS.md at or below the CI byte and line ceiling', () => {
    const text = readFileSync(agentsMdPath, 'utf8');
    const lineCount = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    const byteCount = Buffer.byteLength(text, 'utf8');
    expect(lineCount).toBeLessThanOrEqual(maxLines);
    expect(byteCount).toBeLessThanOrEqual(maxBytes);
  });
});
