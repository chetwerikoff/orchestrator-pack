import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  PACK_AGENTS_END,
  PACK_AGENTS_START,
  adoptTargetAgentsMd,
  packCheckoutRoot,
} from './bootstrap.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-bootstrap-agents-'));
  roots.push(root);
  return root;
}

function writePack(body: Buffer | string): { pack: string; sourcePath: string } {
  const pack = tempDir();
  const sourcePath = join(pack, 'AGENTS.md');
  writeFileSync(sourcePath, body);
  return { pack, sourcePath };
}

function targetAgents(root: string): string {
  return join(root, 'AGENTS.md');
}

describe('target AGENTS.md adoption', () => {
  it('appends one full pack block and preserves an existing project file', () => {
    const source = Buffer.from('complete pack policy\nline-2\n');
    const { pack } = writePack(source);
    const target = tempDir();
    const before = Buffer.concat([Buffer.from('project rules\n'), Buffer.from([0xff, 0x00])]);
    writeFileSync(targetAgents(target), before);

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });
    const after = readFileSync(targetAgents(target));

    expect(result.ok).toBe(true);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.indexOf(PACK_AGENTS_START)).toBe(before.length + 1);
    expect(after.includes(source)).toBe(true);
    expect(countOf(after, PACK_AGENTS_START)).toBe(1);
    expect(countOf(after, PACK_AGENTS_END)).toBe(1);
  });

  it('creates a missing AGENTS.md as one managed block', () => {
    const source = Buffer.from('created pack policy\n');
    const { pack } = writePack(source);
    const target = tempDir();

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });
    const after = readFileSync(targetAgents(target));

    expect(result.ok).toBe(true);
    expect(after.includes(source)).toBe(true);
    expect(countOf(after, PACK_AGENTS_START)).toBe(1);
    expect(countOf(after, PACK_AGENTS_END)).toBe(1);
    expect(after.subarray(0, PACK_AGENTS_START.length).toString()).toBe(PACK_AGENTS_START);
  });

  it('replaces only the managed interval and keeps prefix and suffix bytes', () => {
    const { pack, sourcePath } = writePack('pack-v1\n');
    const target = tempDir();
    const prefix = Buffer.concat([Buffer.from('BEFORE\n'), Buffer.from([0xff, 0x00])]);
    const suffix = Buffer.concat([Buffer.from('\n'), Buffer.from([0xfe]), Buffer.from('AFTER')]);
    writeFileSync(targetAgents(target), Buffer.concat([
      prefix,
      Buffer.from(`${PACK_AGENTS_START}\npack-v1\n${PACK_AGENTS_END}`),
      suffix,
    ]));

    writeFileSync(sourcePath, 'pack-v2\nmore\n');
    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });
    const after = readFileSync(targetAgents(target));
    const startAt = after.indexOf(PACK_AGENTS_START);
    const endAt = after.indexOf(PACK_AGENTS_END);

    expect(result.ok).toBe(true);
    expect(after.subarray(0, prefix.length).equals(prefix)).toBe(true);
    expect(after.subarray(endAt + PACK_AGENTS_END.length).equals(suffix)).toBe(true);
    expect(after.subarray(startAt + PACK_AGENTS_START.length, endAt).toString()).toBe('\npack-v2\nmore\n');
    expect(after.includes('pack-v1')).toBe(false);
  });

  it('is idempotent when the pack source is unchanged', () => {
    const { pack } = writePack('stable pack\n');
    const target = tempDir();
    writeFileSync(targetAgents(target), Buffer.from('owned\n'));

    expect(adoptTargetAgentsMd({ packRoot: pack, targetRoot: target }).ok).toBe(true);
    const first = readFileSync(targetAgents(target));
    expect(adoptTargetAgentsMd({ packRoot: pack, targetRoot: target }).ok).toBe(true);
    expect(readFileSync(targetAgents(target)).equals(first)).toBe(true);
  });

  it.each([
    ['only the start marker', `${PACK_AGENTS_START}\npolicy\n`],
    ['only the end marker', `policy\n${PACK_AGENTS_END}\n`],
    ['more than one start marker', `${PACK_AGENTS_START}\na\n${PACK_AGENTS_END}\n${PACK_AGENTS_START}\n`],
    ['more than one end marker', `${PACK_AGENTS_START}\na\n${PACK_AGENTS_END}\n${PACK_AGENTS_END}\n`],
    ['managed markers are reversed', `${PACK_AGENTS_END}\npolicy\n${PACK_AGENTS_START}\n`],
  ])('leaves the target unchanged for %s', (problem, body) => {
    const { pack } = writePack('fresh pack\n');
    const target = tempDir();
    const before = Buffer.from(body);
    writeFileSync(targetAgents(target), before);

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(problem);
    expect(result.message).toContain(targetAgents(target));
    expect(readFileSync(targetAgents(target)).equals(before)).toBe(true);
  });

  it('rejects a symlink without mutating the referent', () => {
    const { pack } = writePack('pack\n');
    const target = tempDir();
    const referent = join(target, 'project-rules.md');
    const before = Buffer.from('referent-owned\n');
    writeFileSync(referent, before);
    symlinkSync('project-rules.md', targetAgents(target));

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('symlink');
    expect(readFileSync(referent).equals(before)).toBe(true);
    expect(readFileSync(targetAgents(target)).equals(before)).toBe(true);
  });

  it('rejects a non-regular target file without opening it', () => {
    const { pack } = writePack('pack\n');
    const target = tempDir();
    const created = runProcessSync({ command: 'mkfifo', args: [targetAgents(target)] });
    expect(created.ok).toBe(true);

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('not a regular file');
    expect(existsSync(targetAgents(target))).toBe(true);
  });

  it('rejects an aliased pack checkout without changing the source file', () => {
    const source = Buffer.from('canonical pack\n');
    const { pack, sourcePath } = writePack(source);
    const parent = tempDir();
    const alias = join(parent, 'alias');
    symlinkSync(pack, alias);

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: alias });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(pack);
    expect(readFileSync(sourcePath).equals(source)).toBe(true);
  });

  it('rejects a target file that is the source file', () => {
    const source = Buffer.from('linked pack\n');
    const { pack, sourcePath } = writePack(source);
    const target = tempDir();
    linkSync(sourcePath, targetAgents(target));

    const result = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(sourcePath);
    expect(readFileSync(sourcePath).equals(source)).toBe(true);
    expect(readFileSync(targetAgents(target)).equals(source)).toBe(true);
  });

  it.each([PACK_AGENTS_START, PACK_AGENTS_END])(
    'rejects a source pack AGENTS.md that contains %s',
    (marker) => {
      const { pack, sourcePath } = writePack(`policy\n${marker}\n`);
      const sourceBefore = readFileSync(sourcePath);
      const target = tempDir();
      const before = Buffer.from('keep-project\n');
      writeFileSync(targetAgents(target), before);
      const missing = tempDir();

      const existing = adoptTargetAgentsMd({ packRoot: pack, targetRoot: target });
      const absent = adoptTargetAgentsMd({ packRoot: pack, targetRoot: missing });

      expect(existing.ok).toBe(false);
      expect(absent.ok).toBe(false);
      if (!existing.ok) {
        expect(existing.message).toContain(sourcePath);
        expect(existing.message).toContain(targetAgents(target));
      }
      expect(readFileSync(targetAgents(target)).equals(before)).toBe(true);
      expect(existsSync(targetAgents(missing))).toBe(false);
      expect(readFileSync(sourcePath).equals(sourceBefore)).toBe(true);
    },
  );

  it('embeds the complete current checkout AGENTS.md', () => {
    const target = tempDir();
    const source = readFileSync(join(packCheckoutRoot(), 'AGENTS.md'));
    const result = adoptTargetAgentsMd({
      packRoot: packCheckoutRoot(),
      targetRoot: target,
    });
    const after = readFileSync(targetAgents(target));

    expect(result.ok).toBe(true);
    expect(after.includes(source)).toBe(true);
    expect(countOf(after, PACK_AGENTS_START)).toBe(1);
    expect(countOf(after, PACK_AGENTS_END)).toBe(1);
  });
});

function countOf(haystack: Buffer, literal: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(literal, from);
    if (index < 0) return count;
    count += 1;
    from = index + literal.length;
  }
  return count;
}
