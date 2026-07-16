import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyGhJsonCapture,
  prepareGhJsonCommandArguments,
  runGhJsonCommand,
} from './lib/gh-signal-classifier.ts';

function assertGhSignalFoundation(): void {
  const signal = classifyGhJsonCapture(
    { exitCode: 0, stdout: '{"foundation":true}', stderr: 'smoke diagnostic' },
    { expectedRoot: 'object' },
  );
  if (!signal.ok || signal.classification !== 'success') {
    throw new Error(`gh signal foundation smoke failed: ${signal.reason}`);
  }

  const malformed = classifyGhJsonCapture(
    { exitCode: 0, stdout: '[{"id":1}]\n[{"id":2}]\n', stderr: '' },
    { expectedRoot: 'array' },
  );
  if (malformed.ok || malformed.reason !== 'gh_json_parse_failed') {
    throw new Error('gh signal foundation smoke accepted concatenated JSON documents');
  }

  const requestedArgs = ['api', 'repos/acme/repo/issues/849/events', '--paginate'];
  const preparedArgs = prepareGhJsonCommandArguments(requestedArgs, 'array');
  if (preparedArgs.filter((entry) => entry === '--slurp').length !== 1) {
    throw new Error('gh signal foundation smoke did not bind --slurp to paginated array reads');
  }

  const root = mkdtempSync(join(tmpdir(), 'gh-signal-foundation-'));
  try {
    const paginatedFixture = join(root, 'paginated.json');
    writeFileSync(paginatedFixture, JSON.stringify({
      outcome: 'exit',
      exitCode: 0,
      stdout: '[[{"id":1}],[{"id":2}]]\n',
      stderr: 'paginated diagnostic\n',
    }));
    const paginated = runGhJsonCommand({
      command: 'gh',
      args: requestedArgs,
      expectedRoot: 'array',
      fixturePath: paginatedFixture,
    });
    if (!paginated.ok || paginated.classification !== 'success'
      || JSON.stringify(paginated.value) !== '[{"id":1},{"id":2}]') {
      throw new Error(`gh signal paginated foundation smoke failed: ${paginated.reason}`);
    }

    const emptyFixture = join(root, 'empty.json');
    writeFileSync(emptyFixture, JSON.stringify({
      outcome: 'exit',
      exitCode: 0,
      stdout: '[[],[]]\n',
      stderr: '',
    }));
    const empty = runGhJsonCommand({
      command: 'gh',
      args: requestedArgs,
      expectedRoot: 'array',
      fixturePath: emptyFixture,
    });
    if (!empty.ok || empty.classification !== 'empty' || JSON.stringify(empty.value) !== '[]') {
      throw new Error(`gh signal paginated empty smoke failed: ${empty.reason}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function foundationSmokeValue(): string {
  assertGhSignalFoundation();
  return 'typescript-foundation-ok';
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.stdout.write(`${foundationSmokeValue()}\n`);
}
