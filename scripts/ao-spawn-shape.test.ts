import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_SPAWN_DISPLAY_NAME_MAX_LENGTH,
  findRunnableSpawnCommands,
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

  it('requires --prompt on spawn-new runnable instructions (#652)', () => {
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --name wr-i652 --issue 652',
      ),
    ).toContain('missing or empty --prompt');
    expect(
      validateRunnableSpawnCommand(
        'ao spawn --project orchestrator-pack --name wr-i652 --issue 652 --prompt "Implement GitHub issue #652"',
      ),
    ).toEqual([]);
    expect(
      validateRunnableSpawnCommand(
        'ao spawn 652 --project orchestrator-pack --name wr-i652 --issue 652 --prompt "task text"',
      ),
    ).toContain('positional arguments are not allowed on ao spawn');
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

  it('does not skip conditional runnable backtick spawn examples', () => {
    const conditional =
      'If no worker is alive, run `ao spawn --claim-pr 123`.';
    const matches = findRunnableSpawnCommands(conditional);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.command).toBe('ao spawn --claim-pr 123');
    expect(scanSpawnShapeViolations(conditional)).toHaveLength(1);
  });

  it('still skips never-ao-spawn safety prose with incidental "not" wording', () => {
    const safety =
      'not a replacement. Safety: never ao spawn, never --claim-pr';
    expect(findRunnableSpawnCommands(safety)).toEqual([]);
    const backtickSafety = 'prose such as `never ao spawn` remains unchanged.';
    expect(findRunnableSpawnCommands(backtickSafety)).toEqual([]);
  });

  it('detects inline runnable spawn commands in prose', () => {
    const inline =
      'respawned via ao spawn --claim-pr <PR> (ping/respawn discipline below).';
    const matches = findRunnableSpawnCommands(inline);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe('inline');
    expect(matches[0]?.command).toBe('ao spawn --claim-pr <PR>');
    expect(scanSpawnShapeViolations(inline)).toHaveLength(1);
  });
});

describe('scanSpawnShapeCorpus', () => {
  it('passes on the repository corpus and baseline', async () => {
    const { collectDefaultCorpusRelPaths, SPAWN_GATE_CORPUS_REL_PATHS } = await import(
      '../docs/ao-spawn-shape.mjs'
    );
    const corpusRelPaths = await collectDefaultCorpusRelPaths(rootDir);
    for (const relPath of SPAWN_GATE_CORPUS_REL_PATHS) {
      expect(corpusRelPaths).toContain(relPath);
    }
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

  it('validates placeholder respawn templates in backticks', () => {
    const prose = 'Use `ao spawn --claim-pr <PR>` for recovery\n';
    expect(scanSpawnShapeViolations(prose)).toHaveLength(1);
    const valid =
      'Use `ao spawn --project <project> --name "<label>" --claim-pr <PR>` for recovery\n';
    expect(scanSpawnShapeViolations(valid)).toEqual([]);
  });
});
