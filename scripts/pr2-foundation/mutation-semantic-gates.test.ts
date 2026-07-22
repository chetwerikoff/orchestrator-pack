import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import {
  MUTATION_BEHAVIOR_PROBE_KEYS,
} from './mutation-behavior-probes.ts';
import {
  buildBehavioralMutation,
  EXECUTABLE_BEHAVIOR_MUTATION_KEYS,
} from './mutation-behavior-recipes.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';

function mutationKeys(): string[] {
  return Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
    ids.map((mutationId) => `${ac}:${mutationId}`),
  );
}

const importsMutationRecipes = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-behavior-recipes\.ts['"]/u;
const importsSemanticGates = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-semantic-gates\.ts['"]/u;

describe('[AC8] independent behavioral mutation probes', () => {
  it('binds every declared control to an explicit behavioral mutation without semantic-gate fallback', () => {
    const expected = mutationKeys().sort();
    expect([...EXECUTABLE_BEHAVIOR_MUTATION_KEYS]).toEqual(expected);

    const recipes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-recipes.ts'), 'utf8');
    expect(recipes).not.toMatch(importsSemanticGates);
    expect(recipes).not.toContain('buildBoundedSemanticMutation');
    expect(recipes).not.toContain('GATES[');
    expect(recipes).toContain("from './mutation-catalog.ts'");
    expect(recipes).toContain('behavioral_mutation_recipe_set_mismatch');
  });

  it('builds a bounded non-empty mutation plan for every declared control', () => {
    for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
      for (const mutationId of ids) {
        const key = `${ac}:${mutationId}`;
        const bindingPath = FOUNDATION_MUTATION_CATALOG
          .find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
        expect(bindingPath, key).toBeTruthy();
        const absolute = path.resolve(bindingPath!);
        const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
        const plan = buildBehavioralMutation(key, source);
        expect(plan.artifactPath, key).toBe(bindingPath);
        expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
        expect(plan.content, key).not.toBe(source);
      }
    }
  });

  it('binds the full control set to a checker authority independent from mutation recipes', () => {
    const expected = mutationKeys().sort();
    expect([...MUTATION_BEHAVIOR_PROBE_KEYS]).toEqual(expected);

    const checker = readFileSync(path.resolve('scripts/pr2-foundation/mutation-semantic-check.ts'), 'utf8');
    const probes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-probes.ts'), 'utf8');
    const fixtures = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-fixtures.ts'), 'utf8');
    const runner = readFileSync(path.resolve('scripts/pr2-foundation/mutation-runner.ts'), 'utf8');

    expect(checker).toContain("await import('./mutation-behavior-probes.ts')");
    expect(checker).not.toMatch(importsSemanticGates);
    expect(probes).not.toMatch(importsMutationRecipes);
    expect(fixtures).not.toMatch(importsMutationRecipes);
    expect(fixtures).not.toMatch(importsSemanticGates);
    expect(runner).toContain("from './mutation-behavior-recipes.ts'");
  });

  it('uses executable behavioral mutants for the reviewer examples', () => {
    expect(EXECUTABLE_BEHAVIOR_MUTATION_KEYS).toEqual(expect.arrayContaining([
      'AC1:scheduler-acquirer-running',
      'AC1:activation-epoch-enforced',
      'AC2:draft-candidate-accepted',
      'AC2:missing-draft-bit-accepted',
      'AC3:invalid-config-accepted',
      'AC9:modification-outside-independent-union',
      'AC9:declaration-snapshot-missing',
      'AC9:declaration-created-after-implementation',
    ]));

    const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
    const schedulerMutant = buildBehavioralMutation('AC1:scheduler-acquirer-running', scheduler);
    expect(schedulerMutant.content).toContain('running: true');

    const binding = readFileSync(path.resolve('scripts/pr2-foundation/binding.ts'), 'utf8');
    const draftMutant = buildBehavioralMutation('AC2:draft-candidate-accepted', binding);
    expect(draftMutant.content).not.toContain('!row.isDraft &&');

    const config = readFileSync(path.resolve('scripts/pr2-foundation/config.ts'), 'utf8');
    const invalidConfigMutant = buildBehavioralMutation('AC3:invalid-config-accepted', config);
    expect(invalidConfigMutant.content).toContain('return { ok: true, config: DEFAULT_FOUNDATION_CONFIG };');

    const scopeProof = readFileSync(path.resolve('scripts/pr2-foundation/real-scope-proof.ts'), 'utf8');
    const outsideUnionMutant = buildBehavioralMutation(
      'AC9:modification-outside-independent-union',
      scopeProof,
    );
    expect(outsideUnionMutant.content).toContain("'README.md'");
  });
});
