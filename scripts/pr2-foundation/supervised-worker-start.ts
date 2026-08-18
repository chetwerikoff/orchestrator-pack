import { runProcess } from '../kernel/subprocess.ts';
import {
  currentWorkerAssignment,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
  type WorkerAssignmentExpectation,
} from '../lib/worker-assignment-store.ts';
import { admitCurrentWorkerAssignmentReplacement } from '../lib/worker-assignment-runtime.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';

export interface SupervisedWorkerStartReceipt {
  readonly runId?: string;
  readonly taskId?: string;
  readonly dispatchId?: string;
  readonly state?: string;
  readonly stage?: string;
  readonly effects?: readonly unknown[];
  readonly residualResources?: readonly unknown[];
}

interface OrcaWorkerStartEnvelope {
  readonly ok?: boolean;
  readonly result?: unknown;
}

interface OrcaPlacementEnvelope {
  readonly ok?: boolean;
  readonly result?: unknown;
}

interface OrcaPlacementWitness {
  readonly terminalHandle: string;
  readonly worktreeId: string;
}

interface ChildResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface SupervisedWorkerStartResidual {
  readonly authority: 'non_authoritative';
  readonly disposition: 'operator_manual';
  readonly taskId: string;
  readonly dispatchId: string;
  readonly expectedCurrent:
    | { readonly kind: 'none' }
    | { readonly kind: 'exact'; readonly assignmentId: string; readonly generation: number };
  readonly publicationReason: 'assignment_stale' | 'assignment_store_busy';
  readonly residualResources?: readonly unknown[];
}

export interface SupervisedWorkerStartResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly receipt?: SupervisedWorkerStartReceipt;
  readonly residualResources?: readonly unknown[];
  readonly assignment?: WorkerAssignment;
  readonly residual?: SupervisedWorkerStartResidual;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string {
  return String(value ?? '').trim();
}

function residualResources(receipt: SupervisedWorkerStartReceipt): readonly unknown[] | undefined {
  if (Array.isArray(receipt.residualResources)) return receipt.residualResources;
  return Array.isArray(receipt.effects) ? receipt.effects : undefined;
}

function rejectedStart(
  reason: string,
  receipt?: SupervisedWorkerStartReceipt,
): SupervisedWorkerStartResult {
  const resources = receipt ? residualResources(receipt) : undefined;
  return {
    ok: false,
    reason,
    ...(receipt ? { receipt } : {}),
    ...(resources ? { residualResources: resources } : {}),
  };
}

function exactOption(args: readonly string[], name: string): string | null {
  const indexes = args
    .map((arg, index) => arg === name ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length !== 1) return null;
  const value = String(args[indexes[0]! + 1] ?? '').trim();
  return value && !value.startsWith('--') ? value : null;
}

function expectedCurrentForPublish(
  current: WorkerAssignment | null,
): WorkerAssignmentExpectation | undefined {
  return current
    ? { assignmentId: current.assignmentId, generation: current.generation }
    : undefined;
}

function residualDiagnostic(input: {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly current: WorkerAssignment | null;
  readonly publicationReason: 'assignment_stale' | 'assignment_store_busy';
  readonly receipt: SupervisedWorkerStartReceipt;
}): SupervisedWorkerStartResidual {
  const resources = residualResources(input.receipt);
  return {
    authority: 'non_authoritative',
    disposition: 'operator_manual',
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    expectedCurrent: input.current
      ? {
          kind: 'exact',
          assignmentId: input.current.assignmentId,
          generation: input.current.generation,
        }
      : { kind: 'none' },
    publicationReason: input.publicationReason,
    ...(resources ? { residualResources: resources } : {}),
  };
}

function parsePlacementEnvelope(execution: ChildResult): Record<string, unknown> | null {
  if (!execution.ok || !execution.stdout.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(execution.stdout);
    if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

async function resolvePlacementWitness(input: {
  readonly terminalSelector: string;
  readonly worktreeSelector: string;
  readonly inspect: (args: readonly string[]) => Promise<ChildResult>;
}): Promise<{ readonly ok: true; readonly witness: OrcaPlacementWitness } | { readonly ok: false; readonly reason: string }> {
  const terminalExecution = await input.inspect([
    'terminal', 'show', '--terminal', input.terminalSelector, '--json',
  ]);
  const terminalResult = parsePlacementEnvelope(terminalExecution);
  const terminal = terminalResult && isRecord(terminalResult.terminal) ? terminalResult.terminal : null;
  const terminalHandle = nonEmpty(terminal?.handle);
  const terminalWorktreeId = nonEmpty(terminal?.worktreeId);
  if (!terminalHandle || !terminalWorktreeId) {
    return { ok: false, reason: 'supervised_start_terminal_witness_unavailable' };
  }

  const worktreeExecution = await input.inspect([
    'worktree', 'show', '--worktree', input.worktreeSelector, '--json',
  ]);
  const worktreeResult = parsePlacementEnvelope(worktreeExecution);
  const worktree = worktreeResult && isRecord(worktreeResult.worktree) ? worktreeResult.worktree : null;
  const worktreeId = nonEmpty(worktree?.id);
  if (!worktreeId) {
    return { ok: false, reason: 'supervised_start_worktree_witness_unavailable' };
  }
  if (terminalWorktreeId !== worktreeId) {
    return { ok: false, reason: 'supervised_start_terminal_worktree_mismatch' };
  }
  return { ok: true, witness: { terminalHandle, worktreeId } };
}

function validateReceiptPlacement(
  receipt: SupervisedWorkerStartReceipt,
  witness: OrcaPlacementWitness,
): string | null {
  if (!Array.isArray(receipt.effects)) return 'supervised_start_effect_witness_unavailable';
  let worktreeSeen = false;
  let agentTerminalSeen = false;
  for (const raw of receipt.effects) {
    if (!isRecord(raw)) continue;
    const kind = nonEmpty(raw.kind);
    const role = nonEmpty(raw.role);
    const action = nonEmpty(raw.action);
    const id = nonEmpty(raw.id);
    if (kind === 'worktree') {
      if (!id) return 'supervised_start_worktree_witness_unavailable';
      worktreeSeen = true;
      if (id !== witness.worktreeId) return 'supervised_start_worktree_mismatch';
      if (action !== 'reused') return 'supervised_start_worktree_action_mismatch';
      continue;
    }
    if (kind === 'terminal' && role === 'agent') {
      if (!id) return 'supervised_start_terminal_witness_unavailable';
      agentTerminalSeen = true;
      if (id !== witness.terminalHandle) return 'supervised_start_terminal_mismatch';
      if (action !== 'reused' && action !== 'reused_agent_terminal') {
        return 'supervised_start_terminal_action_mismatch';
      }
      continue;
    }
    if (kind === 'dispatch_input' && role === 'agent' && raw.id !== undefined) {
      if (!id || id !== witness.terminalHandle) return 'supervised_start_dispatch_terminal_mismatch';
    }
  }
  if (!worktreeSeen) return 'supervised_start_worktree_witness_unavailable';
  if (!agentTerminalSeen) return 'supervised_start_terminal_witness_unavailable';
  return null;
}

export async function runSupervisedWorkerStart(input: {
  readonly issueNumber: number;
  readonly repository: string;
  readonly projectId?: string;
  readonly orcaArgs: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly adapter?: RuntimeAdapter;
  readonly execute?: (args: readonly string[]) => Promise<ChildResult>;
  readonly inspect?: (args: readonly string[]) => Promise<ChildResult>;
}): Promise<SupervisedWorkerStartResult> {
  const repository = input.repository.trim().toLowerCase();
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0 || !repository) {
    return { ok: false, reason: 'supervised_start_input_invalid' };
  }
  const args = [...input.orcaArgs];
  if (args.length === 0 || args[0] !== '--task' || !String(args[1] ?? '').trim()) {
    return { ok: false, reason: 'supervised_start_task_must_be_first' };
  }
  const requestedTaskId = String(args[1]).trim();
  const terminal = exactOption(args, '--terminal');
  const worktree = exactOption(args, '--worktree');
  if (!terminal || !worktree) {
    return { ok: false, reason: 'supervised_start_exact_terminal_worktree_required' };
  }

  const file = resolveWorkerAssignmentStorePath(input.projectId, input.env ?? process.env);
  const expectedCurrent = currentWorkerAssignment(file, input.issueNumber);
  if (expectedCurrent
    && (expectedCurrent.repository !== repository || expectedCurrent.taskId !== requestedTaskId)) {
    return { ok: false, reason: 'assignment_stale' };
  }
  if (expectedCurrent?.kind === 'local') {
    let adapter = input.adapter;
    if (!adapter) {
      try {
        const env = input.env ?? process.env;
        adapter = await selectRuntimeAdapter(
          { env },
          { cwd: input.cwd ?? process.cwd(), transport: { env } },
        );
      } catch {
        return { ok: false, reason: 'runtime_unavailable' };
      }
    }
    const admission = await admitCurrentWorkerAssignmentReplacement({
      file,
      expected: expectedCurrent,
      adapter,
    });
    if (admission.status !== 'replaceable') {
      return { ok: false, reason: admission.status };
    }
  }

  const inspect = input.inspect ?? (async (inspectArgs) => {
    const result = await runProcess({
      command: 'orca',
      args: [...inspectArgs],
      cwd: input.cwd ?? process.cwd(),
      env: input.env,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 15_000,
    });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error };
  });
  const placement = await resolvePlacementWitness({
    terminalSelector: terminal,
    worktreeSelector: worktree,
    inspect,
  });
  if (!placement.ok) return { ok: false, reason: placement.reason };

  if (!args.includes('--json')) args.push('--json');
  const execute = input.execute ?? (async (workerArgs) => {
    const result = await runProcess({
      command: 'orca',
      args: ['orchestration', 'worker-start', ...workerArgs],
      cwd: input.cwd ?? process.cwd(),
      env: input.env,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 120_000,
    });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error };
  });
  const execution = await execute(args);
  let envelope: OrcaWorkerStartEnvelope;
  try {
    const parsed: unknown = JSON.parse(execution.stdout);
    if (!isRecord(parsed) || !isRecord(parsed.result)) {
      return rejectedStart('supervised_start_receipt_invalid');
    }
    envelope = parsed as OrcaWorkerStartEnvelope;
  } catch {
    return rejectedStart('supervised_start_receipt_invalid');
  }
  const receipt = envelope.result as SupervisedWorkerStartReceipt;
  if (envelope.ok !== true) {
    return rejectedStart('supervised_start_envelope_not_ok', receipt);
  }
  if (!execution.ok || receipt.state !== 'ready') {
    return rejectedStart(`supervised_start_${receipt.state || 'failed'}`, receipt);
  }
  const taskId = String(receipt.taskId ?? '').trim();
  const dispatchId = String(receipt.dispatchId ?? '').trim();
  if (!taskId || !dispatchId) {
    return rejectedStart('supervised_start_identity_missing', receipt);
  }
  if (taskId !== requestedTaskId) {
    return rejectedStart('supervised_start_task_mismatch', receipt);
  }
  const placementReason = validateReceiptPlacement(receipt, placement.witness);
  if (placementReason) return rejectedStart(placementReason, receipt);

  const published = await publishCurrentWorkerAssignment({
    file,
    projectId: input.projectId,
    repository,
    issueNumber: input.issueNumber,
    taskId,
    kind: 'local',
    provider: 'orca',
    bindingKey: dispatchId,
    expectedCurrent: expectedCurrentForPublish(expectedCurrent),
  });
  if (!published.ok) {
    if (published.reason === 'assignment_stale' || published.reason === 'assignment_store_busy') {
      const resources = residualResources(receipt);
      return {
        ok: false,
        reason: published.reason,
        receipt,
        ...(resources ? { residualResources: resources } : {}),
        residual: residualDiagnostic({
          taskId,
          dispatchId,
          current: expectedCurrent,
          publicationReason: published.reason,
          receipt,
        }),
      };
    }
    return rejectedStart(published.reason, receipt);
  }
  return { ok: true, reason: 'ready_and_assignment_bound', receipt, assignment: published.assignment };
}

function parseCli(argv: readonly string[]): {
  issueNumber: number;
  repository: string;
  projectId?: string;
  orcaArgs: string[];
} {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('usage: supervised-worker-start --issue-number N --repository owner/repo [--project-id id] -- --task task_id --terminal handle --worktree selector ...');
  const own = argv.slice(0, separator);
  const orcaArgs = argv.slice(separator + 1);
  const value = (name: string): string => {
    const index = own.indexOf(name);
    return index >= 0 ? String(own[index + 1] ?? '').trim() : '';
  };
  return {
    issueNumber: Number(value('--issue-number')),
    repository: value('--repository'),
    ...(value('--project-id') ? { projectId: value('--project-id') } : {}),
    orcaArgs,
  };
}

if (process.argv[1]?.endsWith('supervised-worker-start.ts')) {
  runSupervisedWorkerStart(parseCli(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
