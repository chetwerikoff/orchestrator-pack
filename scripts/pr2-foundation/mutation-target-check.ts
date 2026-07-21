import {
  evaluateSemanticMutationGate,
  failingTestIdForMutation,
} from './mutation-semantic-gates.ts';

function main(): void {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  if (!key) throw new Error('mutation_key_missing');
  const result = evaluateSemanticMutationGate(key);
  if (!result.ok) {
    process.stderr.write(`${result.failingTestId}: ${result.reason ?? 'semantic_gate_failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`${failingTestIdForMutation(key)}: passed\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
