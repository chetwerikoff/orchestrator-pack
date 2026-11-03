import { mkdtempSync, openSync, closeSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectProcessCensus, type ProcIo } from './operations.ts';
import { defaultProcessCensus } from '../worktree-teardown.ts';

const TARGET = '/work/issue-1';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function stat(ppid: number): string {
  // pid (comm) state ppid ... starttime is field index 19 after ") "
  const fields = Array.from({ length: 22 }, (_, index) => String(index));
  fields[0] = 'S';
  fields[1] = String(ppid);
  fields[19] = '777';
  return `1 (x) ${fields.join(' ')}`;
}

interface FakeProc {
  readonly ppid: number;
  readonly cwd: string | Error;
  readonly fds?: readonly string[] | Error;
}

function fakeIo(table: Record<string, FakeProc>): ProcIo {
  return {
    readdirSync(path) {
      if (path === '/proc') return Object.keys(table);
      const match = /^\/proc\/(\d+)\/fd$/.exec(path);
      const fds = match ? table[match[1]!]?.fds : undefined;
      if (fds instanceof Error) throw fds;
      if (!fds) return [];
      return fds.map((_, index) => String(index));
    },
    readFileSync(path) {
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const row = match ? table[match[1]!] : undefined;
      if (!row) throw errno('ENOENT');
      return stat(row.ppid);
    },
    readlinkSync(path) {
      const cwd = /^\/proc\/(\d+)\/cwd$/.exec(path);
      if (cwd) {
        const value = table[cwd[1]!]!.cwd;
        if (value instanceof Error) throw value;
        return value;
      }
      const fd = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)!;
      return (table[fd[1]!]!.fds as readonly string[])[Number(fd[2])]!;
    },
  };
}

describe('process census with unreadable observations', () => {
  const table: Record<string, FakeProc> = {
    '10': { ppid: 1, cwd: errno('EACCES') },
    '11': { ppid: 1, cwd: errno('EPERM'), fds: errno('EACCES') },
    '12': { ppid: 1, cwd: '/elsewhere' },
    '13': { ppid: 1, cwd: `${TARGET}/sub` },
    '14': { ppid: 1, cwd: '/elsewhere', fds: [`${TARGET}/file.log`] },
    '15': { ppid: 13, cwd: '/elsewhere' },
  };

  it('operations census counts denied cwd/fd reads and keeps real holders', () => {
    const result = collectProcessCensus(TARGET, fakeIo(table));
    expect(result.observations).toEqual({ unreadableCwd: 2, unreadableFd: 1 });
    expect(result.processes.map((row) => row.pid)).toEqual([13, 14, 15]);
    expect(result.processes.find((row) => row.pid === 14)?.fd).toBe(`${TARGET}/file.log`);
  });

  it('operations census still throws on a non-permission cwd error', () => {
    const io = fakeIo({ '20': { ppid: 1, cwd: errno('EIO') } });
    expect(() => collectProcessCensus(TARGET, io)).toThrow(/could not read \/proc\/20\/cwd/);
  });

  it('operations census reports no holder and the denied count when only denied reads exist', () => {
    const result = collectProcessCensus(TARGET, fakeIo({ '10': table['10']! }));
    expect(result.processes).toEqual([]);
    expect(result.observations.unreadableCwd).toBe(1);
  });

  it('teardown census marks denied cwd/fd and keeps readable fd holders', () => {
    const rows = defaultProcessCensus(TARGET, fakeIo(table));
    expect(rows.filter((row) => row.cwdDenied).map((row) => row.pid)).toEqual([10, 11]);
    expect(rows.filter((row) => row.fdDenied).map((row) => row.pid)).toEqual([11]);
    expect(rows.find((row) => row.pid === 14)?.fd).toBe(`${TARGET}/file.log`);
    expect(rows.find((row) => row.pid === 13)?.cwd).toBe(`${TARGET}/sub`);
  });

  it('both censuses see a real open file descriptor under the target', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'census-fd-')));
    try {
      mkdirSync(join(dir, 'tree'));
      const fd = openSync(join(dir, 'tree', 'held.txt'), 'w');
      try {
        const target = join(dir, 'tree');
        const own = collectProcessCensus(target).processes.find((row) => row.pid === process.pid);
        expect(own?.fd).toBe(join(target, 'held.txt'));
        const teardown = defaultProcessCensus(target).find((row) => row.pid === process.pid);
        expect(teardown?.fd).toBe(join(target, 'held.txt'));
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
