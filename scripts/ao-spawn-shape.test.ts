import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_SPAWN_DISPLAY_NAME_MAX_LENGTH,
  findRunnableSpawnCommands,
  isDocumentationSpawnTemplate,
  scanSpawnShapeCorpus,
  scanSpawnShapeViolations,
  tokenizeSpawnArgv,
  validateRunnableSpawnCommand,
} from '../docs/ao-spawn-shape.mjs';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleYaml = readFileSync(
  path.join(rootDir, 'agent-orchestrator.yaml.example'),
  'utf8',
);
const runbook = readFileSync(
  path.join(rootDir, 'docs/orchestrator-recovery-runbook.md'),
  'utf8',
);

describe('validateRunnableSpawnCommand', () => {
  it('accepts AO 0.10.x claim-pr respawn shape', () => {
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --name "Claim PR" --claim-pr 589',
      ),
    ).toEqual([]);
  });

  it('fails when --project or --name is removed', () => {
    expect(
      validateRunnableSpawnCommand('ao spawn --name "Claim PR" --claim-pr 589'),
    ).toContain('missing --project');
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --claim-pr 589',
      ),
    ).toContain('missing or empty --name');
  });

  it('enforces the centralized AO 0.10.x display-name limit', () => {
    const tooLong = 'x'.repeat(AO_SPAWN_DISPLAY_NAME_MAX_LENGTH + 1);
    expect(
      validateRunnableSpawnCommand(
        `ao spawn --project orchestrator-pack --name "${tooLong}" --claim-pr 589`,
      ),
    ).toEqual([
      `--name exceeds ${AO_SPAWN_DISPLAY_NAME_MAX_LENGTH} chars (AO 0.10.x display label limit)`,
    ]);
  });

  it('parses quoted multi-word --name before enforcing length', () => {
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --name "This Label Is Far Too Long" --claim-pr 589',
      ),
    ).toEqual([
      `--name exceeds ${AO_SPAWN_DISPLAY_NAME_MAX_LENGTH} chars (AO 0.10.x display label limit)`,
    ]);
  });

  it('rejects another option flag as a missing --project or --name value', () => {
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --name --claim-pr 589',
      ),
    ).toContain('missing or empty --name');
    expect(
      validateRunnableSpawnCommand('ao spawn --project --claim-pr 589 --name "Claim PR"'),
    ).toContain('missing --project');
    expect(
      validateRunnableSpawnCommand('ao spawn --project=--claim-pr --name "Claim PR"'),
    ).toContain('missing --project');
  });
});

describe('tokenizeSpawnArgv', () => {
  it('preserves quoted values as single tokens', () => {
    expect(
      tokenizeSpawnArgv(
        'ao spawn --project orchestrator-pack --name "This Label Is Far Too Long" --claim-pr 589',
      ),
    ).toEqual([
      'ao',
      'spawn',
      '--project',
      'orchestrator-pack',
      '--name',
      'This Label Is Far Too Long',
      '--claim-pr',
      '589',
    ]);
  });
});

describe('findRunnableSpawnCommands', () => {
  it('detects indented respawn discipline command lines', () => {
    const matches = findRunnableSpawnCommands(exampleYaml);
    expect(matches.some((match) => match.command.includes('--claim-pr'))).toBe(true);
    expect(
      matches.find((match) => match.command.includes('--claim-pr'))?.command,
    ).toMatch(/--project\b/);
    expect(
      matches.find((match) => match.command.includes('--claim-pr'))?.command,
    ).toMatch(/--name\b/);
  });

  it('ignores never-ao-spawn safety prose in the example yaml', () => {
    const matches = findRunnableSpawnCommands(exampleYaml);
    expect(
      matches.every((match) => !/\bnever\b/i.test(match.command)),
    ).toBe(true);
  });

  it('detects operator runbook claim-pr templates while skipping negated mentions', () => {
    const matches = findRunnableSpawnCommands(runbook);
    const commands = matches.map((match) => match.command);
    expect(commands.some((command) => command.includes('--project'))).toBe(true);
    expect(commands.some((command) => command === 'ao spawn --claim-pr')).toBe(false);
  });
});

describe('scanSpawnShapeCorpus', () => {
  it('passes on the repository corpus and baseline', async () => {
    const { collectDefaultCorpusRelPaths } = await import('../docs/ao-spawn-shape.mjs');
    const corpusRelPaths = await collectDefaultCorpusRelPaths(rootDir);
    const violations = await scanSpawnShapeCorpus(rootDir, {
      corpusRelPaths,
      baselineRelPath: 'scripts/fixtures/ao-spawn-shape/safety-prose-baseline.json',
    });
    expect(violations).toEqual([]);
  });

  it('fails when a claim-pr respawn example drops a required flag', () => {
    const valid =
      '        ao spawn --project orchestrator-pack --name "Claim PR" --claim-pr <PR>\n';
    expect(scanSpawnShapeViolations(valid)).toEqual([]);

    const missingProject = '        ao spawn --name "Claim PR" --claim-pr <PR>\n';
    expect(scanSpawnShapeViolations(missingProject)).toHaveLength(1);

    const missingName =
      '        ao spawn --project orchestrator-pack --claim-pr <PR>\n';
    expect(scanSpawnShapeViolations(missingName)).toHaveLength(1);
  });

  it('does not globally whitelist forbidden runnable line shapes', () => {
    const badRunnableLine = '        ao spawn --claim-pr <PR>\n';
    expect(scanSpawnShapeViolations(badRunnableLine)).toHaveLength(1);
  });

  it('skips backtick documentation templates with placeholders', () => {
    const prose = 'Use `ao spawn --claim-pr <PR>` for recovery\n';
    expect(scanSpawnShapeViolations(prose)).toEqual([]);
    expect(
      isDocumentationSpawnTemplate({
        line: 1,
        command: 'ao spawn --claim-pr <PR>',
        kind: 'backtick',
      }),
    ).toBe(true);
  });
});
