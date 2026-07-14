export function foundationSmokeValue(): string {
  return 'typescript-foundation-ok';
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.stdout.write(`${foundationSmokeValue()}\n`);
}
