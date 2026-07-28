import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const launcher = join(root, 'scripts/lib/Invoke-TypeScriptCli.ts');
const producer = join(root, 'scripts/json-producers/read-delegation-audit-stop.ts');

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', launcher, '--script', producer, '--', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);
