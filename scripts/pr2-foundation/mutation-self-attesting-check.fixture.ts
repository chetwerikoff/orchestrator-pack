import '../toolchain/native-entrypoint-preflight.ts';

import {
  evaluateSemanticMutationGate,
  failingTestIdForMutation,
} from './mutation-semantic-gates.ts';

function main(): void {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  if (!key) throw new Error('mutation_key_missing');
  const failingTestId = failingTestIdForMutation(key);
  const result = evaluateSemanticMutationGate(key);
  if (!result.ok) {
    process.stderr.write(`${failingTestId}: ${result.reason}\n`);
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
