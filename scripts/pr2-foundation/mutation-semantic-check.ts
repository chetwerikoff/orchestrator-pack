import '../toolchain/native-entrypoint-preflight.ts';

function mutationKey(): string {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  if (!key) throw new Error('mutation_key_missing');
  return key;
}

async function main(): Promise<void> {
  const key = mutationKey();
  const failingTestId = `mutation-contract:${key}`;
  try {
    const { runBehavioralMutationProbe } = await import('./mutation-behavior-probes.ts');
    runBehavioralMutationProbe(key);
  } catch (error) {
    process.stderr.write(`${failingTestId}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${failingTestId}: passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
