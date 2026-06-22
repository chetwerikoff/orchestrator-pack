import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function withTempGitRepo(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autonomous-boundary-'));
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
    writeFileSync(path.join(dir, 'README.md'), 'test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf8' });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
