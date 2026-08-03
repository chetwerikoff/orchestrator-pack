import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { __testPublishStateLightReply } from './state-light-turn.ts';

const [mode, rootArgument] = process.argv.slice(2);
if (mode !== 'before-link' && mode !== 'after-link') {
  throw new Error('tab_lifecycle_fixture_mode_invalid');
}

const root = resolve(rootArgument ?? '');
const output = resolve(root, 'reply.txt');
const barrier = resolve(root, `${mode}.barrier`);
const release = resolve(root, `${mode}.release`);
const closeWitness = resolve(root, `${mode}.page-close`);
const reply = `subprocess ${mode} reply`;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

const waitAtBarrier = (): void => {
  writeFileSync(barrier, 'ready\n', 'utf8');
  while (!existsSync(release)) Atomics.wait(waitCell, 0, 0, 20);
};

const publication = __testPublishStateLightReply(
  output,
  '123e4567-e89b-12d3-a456-426614174010',
  reply,
  mode === 'before-link'
    ? { beforeFinalLink: waitAtBarrier }
    : { afterFinalLink: waitAtBarrier },
);

if (publication.state === 'committed_ok') {
  writeFileSync(closeWitness, 'page-close\n', 'utf8');
}
process.stdout.write(`${JSON.stringify(publication)}\n`);
