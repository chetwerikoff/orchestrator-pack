import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retiredDocs = [
  'docs/orchestrator-autoloop-go-live.md',
  'docs/orchestrator-wake-runbook.md',
  'docs/fleet-liveness-contract.md',
  'docs/review-status-consumer-inventory.md',
  'docs/issue-906-operator-adoption.md',
] as const;
const retainedOperatorDocs = [
  'docs/wake-supervisor-fleet-operator-reference.md',
  'docs/orchestrator-recovery-runbook.md',
] as const;
const historicalDocRoots = new Set([
  'docs/issues_drafts',
  'docs/declarations',
  'docs/investigations',
]);
const instructionExtensions = new Set(['.md', '.mdc', '.txt']);

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function activeInstructionFiles(): string[] {
  const files = [
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    ...walkFiles(resolve(repoRoot, '.cursor/skills'))
      .filter((path) => path.endsWith('/SKILL.md') || path.endsWith('\\SKILL.md'))
      .map((path) => normalize(relative(repoRoot, path))),
    ...walkFiles(resolve(repoRoot, '.claude/skills'))
      .filter((path) => path.endsWith('/SKILL.md') || path.endsWith('\\SKILL.md'))
      .map((path) => normalize(relative(repoRoot, path))),
    ...walkFiles(resolve(repoRoot, '.cursor/rules'))
      .filter((path) => instructionExtensions.has(extname(path)))
      .map((path) => normalize(relative(repoRoot, path))),
    ...walkFiles(resolve(repoRoot, 'prompts'))
      .filter((path) => instructionExtensions.has(extname(path)))
      .map((path) => normalize(relative(repoRoot, path))),
    ...walkFiles(resolve(repoRoot, 'docs'))
      .filter((path) => instructionExtensions.has(extname(path)))
      .map((path) => normalize(relative(repoRoot, path)))
      .filter((path) => ![...historicalDocRoots].some((root) => path === root || path.startsWith(`${root}/`))),
  ];
  return [...new Set(files)].filter((path) => existsSync(resolve(repoRoot, path))).sort();
}

function scriptReferences(content: string): string[] {
  const matches = content.matchAll(/(?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs|ps1|sh|json)/gu);
  return [...new Set([...matches].map((match) => normalize(match[0]!)))].sort();
}

function forbiddenRuntimeConfigRefs(content: string): string[] {
  const matches = content.matchAll(/\bagent-orchestrator(?:\.[A-Za-z0-9_-]+)?\.yaml\b/gu);
  return [...new Set([...matches]
    .map((match) => match[0]!)
    .filter((value) => value !== 'agent-orchestrator.yaml.example'))].sort();
}

describe('active instruction truth', () => {
  it('keeps only the live operator runbooks and the registry-owned single child roster', () => {
    for (const path of retiredDocs) expect(existsSync(resolve(repoRoot, path)), path).toBe(false);
    for (const path of retainedOperatorDocs) expect(existsSync(resolve(repoRoot, path)), path).toBe(true);

    const registryPath = resolve(repoRoot, 'scripts/orchestrator-side-process-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      requiredChildIds?: unknown;
      children?: Array<{ id?: unknown; script?: unknown }>;
    };
    const required = Array.isArray(registry.requiredChildIds)
      ? registry.requiredChildIds.map(String)
      : [];
    const children = Array.isArray(registry.children) ? registry.children : [];
    const ids = children.map((child) => String(child.id ?? ''));
    expect(required).toEqual(['pr2-scheduler']);
    expect(ids).toEqual(required);
    for (const child of children) {
      const script = String(child.script ?? '');
      expect(script).not.toBe('');
      expect(existsSync(resolve(repoRoot, 'scripts', script)), `registry child script ${script}`).toBe(true);
    }
  });

  it('rejects active references to retired config/docs and nonexistent literal script targets', () => {
    const failures: string[] = [];
    for (const path of activeInstructionFiles()) {
      const content = readFileSync(resolve(repoRoot, path), 'utf8');
      if (content.includes('prompts/agent_rules.md')) failures.push(`${path}: prompts/agent_rules.md`);
      for (const retired of retiredDocs) {
        if (content.includes(retired)) failures.push(`${path}: ${retired}`);
      }
      for (const config of forbiddenRuntimeConfigRefs(content)) failures.push(`${path}: ${config}`);
      for (const target of scriptReferences(content)) {
        const full = resolve(repoRoot, target);
        if (!existsSync(full) || !statSync(full).isFile()) failures.push(`${path}: missing ${target}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the active Cursor GitHub rule and tiering pre-flight anchored to AGENTS', () => {
    const cursorRule = readFileSync(resolve(repoRoot, '.cursor/rules/github-rest-over-graphql.mdc'), 'utf8');
    expect(cursorRule).toContain('AGENTS.md');
    expect(cursorRule).not.toContain('prompts/agent_rules.md');

    const tiering = readFileSync(resolve(repoRoot, 'docs/tiering.md'), 'utf8');
    expect(tiering).toContain('Worker **pre-flight**');
    expect(tiering).toContain('[`AGENTS.md`](../AGENTS.md)');
  });
});
