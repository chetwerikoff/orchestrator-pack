import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const launcher = join(root, 'scripts/lib/Invoke-TypeScriptCli.ts');
const producer = join(root, 'scripts/json-producers/read-delegation-audit-stop.ts');

const result = runProcessSync({
  command: process.execPath,
  args: ['--experimental-strip-types', launcher, '--script', producer, '--', ...process.argv.slice(2)],
  inheritParentEnv: true,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode ?? 1);
