import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { abandonPreImportCordon, activateCutover } from './lib/cutover/activation-transaction.ts';
import { provePreImportRollbackSafe, recoverCommittedCutover } from './lib/cutover/activation-recovery.ts';
import type { ActivationRequest } from './lib/cutover/types.ts';
import { resolveTargetContext } from './lib/target-context.ts';
import { withPackProjectStateMigration } from './lib/cutover/project-state-migration.ts';
import { assertProjectStateBinding, readProjectStateBinding } from './lib/project-state-binding.ts';

function loadRequest(file: string): ActivationRequest {
  const raw = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as ActivationRequest;
  if (!raw || !raw.epochId || !raw.paths || !Array.isArray(raw.stores)) throw new Error('activation_request_invalid');
  return raw;
}

function option(argv: readonly string[], name: string): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`${name} is required exactly once`);
  const value = String(argv[indexes[0]! + 1] ?? '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, requestFile, ...argv] = process.argv.slice(2);
  if (!command || !requestFile) throw new Error('usage: orchestrator-cutover-activate.ts activate|recover|prove-rollback|rollback-preimport <request.json> --project <id>');
  const projectId = option(argv, '--project');
  if (argv.length !== 2) throw new Error('unknown activation argument');
  const target = resolveTargetContext({ projectId });
  const loaded = loadRequest(requestFile);
  if (loaded.projectId && loaded.projectId !== target.projectId) throw new Error('activation_project_binding_mismatch');
  if (loaded.repository && loaded.repository.toLowerCase() !== target.repository) throw new Error('activation_repository_binding_mismatch');
  const request: ActivationRequest = withPackProjectStateMigration(
    { ...loaded, projectId: target.projectId, repository: target.repository },
    target.projectId,
  );
  const existingBinding = readProjectStateBinding(request.paths.stateDir);
  if (existingBinding) {
    assertProjectStateBinding(request.paths.stateDir, {
      projectId: target.projectId,
      repository: target.repository,
    });
  }
  if (command === 'activate') {
    process.stdout.write(`${JSON.stringify(await activateCutover(request))}\n`);
    return;
  }
  if (command === 'recover') {
    process.stdout.write(`${JSON.stringify(await recoverCommittedCutover(request))}\n`);
    return;
  }
  if (command === 'prove-rollback') {
    process.stdout.write(`${JSON.stringify(provePreImportRollbackSafe(request))}\n`);
    return;
  }
  if (command === 'rollback-preimport') {
    const proof = provePreImportRollbackSafe(request);
    abandonPreImportCordon(request);
    process.stdout.write(`${JSON.stringify({
      result: 'pre-import-rollback-released',
      proof,
      oldInstalledRevisionRoot: request.oldInstalledRevisionRoot,
      legacySupervisorPid: request.legacySupervisorPid,
      operatorRestartRequired: true,
      note: 'The cutover implementation never dispatches PowerShell. Restart, if required, must use the captured immutable old installed revision outside the new cutover path.',
    })}\n`);
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
