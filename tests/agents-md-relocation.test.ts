import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repoRoot, 'tests/fixtures/agent-rules-relocation-musts.json');
const agentsMd = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');

type RelocationFixture = {
  mustPhrases: string[];
  docsOnlyPhrases: Array<{ phrase: string; path: string }>;
  pointerOnlyPhrases: Array<{ phrase: string; paths: string[] }>;
};

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as RelocationFixture;

describe('agent rules relocation completeness', () => {
  it('preserves worker-normative MUST/trigger phrases in AGENTS.md', () => {
    const missing = fixture.mustPhrases.filter((phrase) => !agentsMd.includes(phrase));
    expect(missing, `missing from AGENTS.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('places script-owned phrases in docs targets only', () => {
    for (const { phrase, path: relPath } of fixture.docsOnlyPhrases) {
      expect(agentsMd.includes(phrase), `AGENTS.md must not inline docs-only phrase: ${phrase}`).toBe(false);
      const docText = readFileSync(path.join(repoRoot, relPath), 'utf8');
      expect(docText.includes(phrase), `${relPath} missing phrase: ${phrase}`).toBe(true);
    }
  });

  it('keeps RCA pointer targets outside AGENTS.md normative body', () => {
    for (const { phrase, paths } of fixture.pointerOnlyPhrases) {
      const foundInPointer = paths.some((relPath) =>
        readFileSync(path.join(repoRoot, relPath), 'utf8').includes(phrase),
      );
      expect(foundInPointer, `pointer target missing phrase: ${phrase}`).toBe(true);
    }
  });
});

describe('agent rules live-reference gate', () => {
  it('finds no live prompts/agent_rules.md references outside excluded paths', () => {
    const excludedPrefixes = ['docs/declarations/', 'docs/issues_drafts/'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSafe(dir)) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(repoRoot, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (excludedPrefixes.some((prefix) => rel.startsWith(prefix))) continue;
        if (rel === 'scripts/check-agent-rules-grep-inventory.ps1') continue;
        const text = readFileSync(full, 'utf8');
        if (/prompts\/agent_rules\.md/.test(text)) {
          offenders.push(rel);
        }
      }
    };
    walk(repoRoot);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

function readdirSafe(dir: string) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory()) return true;
    return entry.name !== '.git' && entry.name !== 'node_modules';
  });
}
