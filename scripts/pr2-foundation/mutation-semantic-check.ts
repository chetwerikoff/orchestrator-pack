import {
  behavioralProbeIdForMutation,
  runBehavioralMutationProbe,
} from './mutation-behavior-probes.ts';

function mutationKey(): string {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  if (!key) throw new Error('mutation_key_missing');
  return key;
}

function main(): void {
  const key = mutationKey();
  const failingTestId = behavioralProbeIdForMutation(key);
  try {
    runBehavioralMutationProbe(key);
  } catch (error) {
    process.stderr.write(`${failingTestId}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${failingTestId}: passed\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
