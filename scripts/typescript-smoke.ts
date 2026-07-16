import { classifyGhJsonCapture } from './lib/gh-signal-classifier.ts';

export function foundationSmokeValue(): string {
  const signal = classifyGhJsonCapture(
    { exitCode: 0, stdout: '{"foundation":true}', stderr: 'smoke diagnostic' },
    { expectedRoot: 'object' },
  );
  if (!signal.ok || signal.classification !== 'success') {
    throw new Error(`gh signal foundation smoke failed: ${signal.reason}`);
  }
  return 'typescript-foundation-ok';
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.stdout.write(`${foundationSmokeValue()}\n`);
}
