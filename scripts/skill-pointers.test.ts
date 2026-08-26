import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateSkillPointerDrift, writeSkillPointers } from './skill-pointers.ts';

const roots: string[] = [];

function fixture(withSupport = false): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-skill-pointers-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.cursor/skills/example'), { recursive: true });
  writeFileSync(join(root, 'scripts/skill-pointer-targets.json'), `${JSON.stringify({
    canonicalRoot: '.cursor/skills',
    targets: [{ root: '.claude/skills', canonicalLinkPrefix: '../../../.cursor/skills' }],
    implementationSupport: withSupport ? ['.claude/skills/example/helper.mjs'] : [],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, '.cursor/skills/example/SKILL.md'), [
    '---',
    'name: example',
    'description: >-',
    '  Canonical Cursor procedure.',
    '---',
    '',
    '# Procedure',
    '',
    'Do the governed work.',
    '',
  ].join('\n'), 'utf8');
  if (withSupport) {
    mkdirSync(join(root, '.claude/skills/example'), { recursive: true });
    writeFileSync(join(root, '.claude/skills/example/helper.mjs'), 'export const helper = true;\n', 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Cursor-owned skill pointer generation', () => {
  it('copies discovery frontmatter and emits only one Claude pointer instruction', () => {
    const root = fixture();
    expect(writeSkillPointers(root)).toBe(1);
    const pointer = readFileSync(join(root, '.claude/skills/example/SKILL.md'), 'utf8');
    expect(pointer).toBe([
      '---',
      'name: example',
      'description: >-',
      '  Canonical Cursor procedure.',
      '---',
      '',
      'Read and execute [`.cursor/skills/example/SKILL.md`](../../../.cursor/skills/example/SKILL.md) in full. Do not re-derive the workflow inline.',
      '',
    ].join('\n'));
    expect(evaluateSkillPointerDrift(root)).toEqual([]);
  });

  it('preserves classified implementation helpers outside the canonical procedure root', () => {
    const root = fixture(true);
    expect(writeSkillPointers(root)).toBe(1);
    expect(readFileSync(join(root, '.claude/skills/example/helper.mjs'), 'utf8')).toContain('helper = true');
    expect(evaluateSkillPointerDrift(root)).toEqual([]);
  });

  it('rejects independent Claude policy, unclassified files, and reverse pointers', () => {
    const root = fixture();
    writeSkillPointers(root);
    const pointerPath = join(root, '.claude/skills/example/SKILL.md');
    writeFileSync(pointerPath, `${readFileSync(pointerPath, 'utf8')}Independent policy.\n`, 'utf8');
    writeFileSync(join(root, '.claude/skills/example/notes.md'), 'not generated\n', 'utf8');
    const canonicalPath = join(root, '.cursor/skills/example/SKILL.md');
    writeFileSync(canonicalPath, `${readFileSync(canonicalPath, 'utf8')}Read and execute [\`.claude/skills/example/SKILL.md\`].\n`, 'utf8');
    const failures = evaluateSkillPointerDrift(root);
    expect(failures).toContain('pointer drift: .claude/skills/example/SKILL.md');
    expect(failures).toContain('pointer skill contains unclassified files: .claude/skills/example: notes.md');
    expect(failures).toContain('reverse pointer in canonical skill: .cursor/skills/example/SKILL.md');
  });

  it('rejects support duplicated under the canonical procedure root', () => {
    const root = fixture(true);
    writeSkillPointers(root);
    writeFileSync(join(root, '.cursor/skills/example/helper.mjs'), 'duplicate\n', 'utf8');
    expect(evaluateSkillPointerDrift(root)).toContain(
      'implementation support duplicated under canonical root: .cursor/skills/example/helper.mjs',
    );
  });

  it('rejects the deleted OpenCode merge alias in either skill root', () => {
    const root = fixture();
    writeSkillPointers(root);
    mkdirSync(join(root, '.cursor/skills/opencode-merge-and-pull'), { recursive: true });
    writeFileSync(join(root, '.cursor/skills/opencode-merge-and-pull/SKILL.md'), '---\nname: opencode-merge-and-pull\ndescription: retired\n---\n', 'utf8');
    const failures = evaluateSkillPointerDrift(root);
    expect(failures.some((failure) => failure.includes('retired skill reappeared'))).toBe(true);
  });
});
