import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { abandonPreImportCordon, activateCutover } from './lib/cutover/activation-transaction.ts';
import { provePreImportRollbackSafe, recoverCommittedCutover } from './lib/cutover/activation-recovery.ts';
import type { ActivationRequest } from './lib/cutover/types.ts';

function loadRequest(file: string): ActivationRequest {
  const raw = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as ActivationRequest;
  if (!raw || !raw.epochId || !raw.paths || !Array.isArray(raw.stores)) throw new Error('activation_request_invalid');
  return raw;
}

async function main(): Promise<void> {
  const [command, requestFile] = process.argv.slice(2);
  if (!command || !requestFile) throw new Error('usage: orchestrator-cutover-activate.ts activate|recover|prove-rollback|rollback-preimport <request.json>');
  const request = loadRequest(requestFile);
  if (command === 'activate') {
    process.stdout.write(`${JSON.stringify(await activateCutover(request))}\n`);
    return;
  }
  if (command === 'recover') {
    process.stdout.write(`${JSON.stringify(recoverCommittedCutover(request))}\n`);
    return;
  }
  if (command === 'prove-rollback') {
    process.stdout.write(`${JSON.stringify(provePreImportRollbackSafe(request))}\n`);
    return;
  }
  if (command === 'rollback-preimport') {
    const proof = provePreImportRollbackSafe(request);
    abandonPreImportCordon(request);
    process.stdout.write(`${JSON.stringify({ result: 'pre-import-rollback-released', proof, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot })}\n`);
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
