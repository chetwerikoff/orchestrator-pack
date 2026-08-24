import { runProcess } from '../kernel/subprocess.ts';
import {
  attachWorkerAssignmentIssueNumber,
  currentWorkerAssignment,
  currentWorkerAssignmentByDeliverable,
  inspectWorkerAssignmentStore,
  parseWorkerAssignmentRole,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
  type WorkerAssignmentExpectation,
  type WorkerAssignmentRecord,
  type WorkerAssignmentRole,
  type WorkerAssignmentStoreTrustCause,
} from '../lib/worker-assignment-store.ts';
import { existsSync, readFileSync } from 'node:fs';
import { admitCurrentWorkerAssignmentReplacement } from '../lib/worker-assignment-runtime.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';

export interface SupervisedWorkerStartReceipt {
  readonly runId?: string;
  readonly taskId?: string;
  readonly dispatchId?: string;
  readonly state?: string;
  readonly stage?: string;
  readonly setup?: unknown;
  readonly launch?: unknown;
  readonly worktree?: unknown;
  readonly terminal?: unknown;
  readonly effects?: readonly unknown[];
  readonly residualResources?: readonly unknown[];
}

export type WorkerStartMode = 'exact_terminal_worktree' | 'provider_new_top_level';

interface OrcaWorkerStartEnvelope {
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly data?: unknown;
  };
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

export interface SupervisedWorkerStartRecoveryEvidence {
  readonly requestId: string;
  readonly dispatchId?: string;
  readonly recoveryCommand?: string;
}

export interface SupervisedWorkerStartResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly cause?: WorkerAssignmentStoreTrustCause;
  /** Exact provider error code from a structurally valid Orca error envelope. */
  readonly errorCode?: string;
  /** Exact non-secret provider recovery fields from Orca error.data, when present. */
  readonly recovery?: SupervisedWorkerStartRecoveryEvidence;
  readonly receipt?: SupervisedWorkerStartReceipt;
  readonly residualResources?: readonly unknown[];
  readonly assignment?: WorkerAssignmentRecord;
  readonly residual?: SupervisedWorkerStartResidual;
}

export type SupervisedWorkerIssueAttachResult =
  | { readonly ok: true; readonly reason: 'issue_metadata_attached'; readonly assignment: WorkerAssignment }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string {
  return String(value ?? '').trim();
}

function providerText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recoveryRequestIdField(
  data: Record<string, unknown>,
  name: 'orchestrationRequestId' | 'requestId',
): { readonly present: boolean; readonly value: string } | null {
  if (!Object.hasOwn(data, name)) return { present: false, value: '' };
  const value = providerText(data[name]);
  return value ? { present: true, value } : null;
}

function recoveryEvidence(error: unknown): SupervisedWorkerStartRecoveryEvidence | undefined {
  if (!isRecord(error) || !isRecord(error.data)) return undefined;
  const orchestrationRequestId = recoveryRequestIdField(error.data, 'orchestrationRequestId');
  const requestId = recoveryRequestIdField(error.data, 'requestId');
  if (!orchestrationRequestId || !requestId) return undefined;
  if (orchestrationRequestId.present && requestId.present
    && orchestrationRequestId.value !== requestId.value) return undefined;
  const exactRequestId = orchestrationRequestId.value || requestId.value;
  if (!exactRequestId) return undefined;
  const dispatchId = providerText(error.data.dispatchId);
  const recoveryCommand = providerText(error.data.recoveryCommand);
  return {
    requestId: exactRequestId,
    ...(dispatchId ? { dispatchId } : {}),
    ...(recoveryCommand ? { recoveryCommand } : {}),
  };
}

function residualResources(receipt: SupervisedWorkerStartReceipt): readonly unknown[] | undefined {
  if (Array.isArray(receipt.residualResources)) return receipt.residualResources;
  return Array.isArray(receipt.effects) ? receipt.effects : undefined;
}

function rejectedStart(
  reason: string,
  receipt?: SupervisedWorkerStartReceipt,
  errorCode?: string,
  recovery?: SupervisedWorkerStartRecoveryEvidence,
  cause?: WorkerAssignmentStoreTrustCause,
): SupervisedWorkerStartResult {
  const resources = receipt ? residualResources(receipt) : undefined;
  return {
    ok: false,
    reason,
    ...(cause ? { cause } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(recovery ? { recovery } : {}),
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

function providerOption(args: readonly string[], name: string): string | null {
  return exactOption(args, name);
}

function providerLaunchField(value: unknown, name: 'agent' | 'model' | 'effort'): string {
  return isRecord(value) ? providerText(value[name]) : '';
}

function validateProviderTopLevelReceipt(
  receipt: SupervisedWorkerStartReceipt,
  args: readonly string[],
): string | null {
  const worktree = isRecord(receipt.worktree) ? receipt.worktree : null;
  const terminal = isRecord(receipt.terminal) ? receipt.terminal
    : isRecord((receipt as Record<string, unknown>).agentTerminal)
      ? (receipt as Record<string, unknown>).agentTerminal as Record<string, unknown>
      : null;

  const effects = receipt.effects;
  if (!Array.isArray(effects)) return 'supervised_start_effect_witness_unavailable';
  const worktreeEffects = effects.filter((raw) => isRecord(raw)
    && providerText(raw.kind) === 'worktree'
    && (providerText(raw.action) === 'created' || providerText(raw.action) === 'created_top_level'));
  const terminalEffects = effects.filter((raw) => isRecord(raw)
    && providerText(raw.kind) === 'terminal' && providerText(raw.role) === 'agent'
    && (providerText(raw.action) === 'created'
      || providerText(raw.action) === 'created_agent_terminal'
      || providerText(raw.action) === 'reused_agent_terminal'));
  const dispatchInputEffects = effects.filter((raw) => isRecord(raw)
    && providerText(raw.kind) === 'dispatch_input'
    && providerText(raw.role) === 'agent'
    && providerText(raw.state) === 'accepted');
  const worktreeEffect = isRecord(worktreeEffects[0]) ? worktreeEffects[0] : null;
  const terminalEffect = isRecord(terminalEffects[0]) ? terminalEffects[0] : null;
  const dispatchInputEffect = isRecord(dispatchInputEffects[0]) ? dispatchInputEffects[0] : null;
  const worktreeId = providerText(worktree?.id) || providerText(worktreeEffect?.id);
  const worktreePath = providerText(worktree?.path) || worktreeId.split('::').slice(1).join('::').trim();
  const terminalHandle = providerText(terminal?.handle) || providerText(terminal?.id) || providerText(terminalEffect?.id);
  if (!worktreeId || !worktreePath || worktreeEffects.length !== 1) return 'supervised_start_provider_placement_missing';
  if (providerText(worktreeEffect?.id) !== worktreeId) return 'supervised_start_provider_worktree_mismatch';
  if (!terminalHandle || terminalEffects.length !== 1) return 'supervised_start_provider_placement_missing';
  if (providerText(terminalEffect?.id) !== terminalHandle) return 'supervised_start_provider_terminal_mismatch';
  if (dispatchInputEffects.length !== 1) return 'supervised_start_provider_dispatch_input_missing';
  if (providerText(dispatchInputEffect?.id) !== terminalHandle) return 'supervised_start_provider_dispatch_input_mismatch';

  const worktreeSelector = providerOption(args, '--worktree');
  const repository = providerOption(args, '--repo');
  const name = providerOption(args, '--name');
  const agent = providerOption(args, '--agent');
  const model = providerOption(args, '--model');
  const effort = providerOption(args, '--effort');
  const setupRequest = providerOption(args, '--setup');
  if (worktreeSelector !== 'new-top-level' || !repository?.startsWith('id:')
    || !name || agent !== 'cursor' || !model || !effort || setupRequest !== 'run') {
    return 'supervised_start_provider_request_invalid';
  }

  const setup = isRecord(receipt.setup) ? receipt.setup : null;
  const setupState = providerText(setup?.state);
  const setupRequested = providerText(setup?.requested);
  if (setupRequested !== 'run' || !['running', 'succeeded', 'not_configured'].includes(setupState)) {
    return 'supervised_start_provider_setup_invalid';
  }

  const launch = isRecord(receipt.launch) ? receipt.launch : null;
  const requested = launch && isRecord(launch.requested) ? launch.requested : null;
  const effective = launch && isRecord(launch.effective) ? launch.effective : null;
  if (!requested || !effective
    || providerLaunchField(requested, 'agent') !== agent
    || providerLaunchField(requested, 'model') !== model
    || providerLaunchField(requested, 'effort') !== effort
    || providerLaunchField(effective, 'agent') !== agent
    || providerLaunchField(effective, 'model') !== model
    || providerLaunchField(effective, 'effort') !== effort) {
    return 'supervised_start_provider_launch_mismatch';
  }
  return null;
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
  readonly mode?: WorkerStartMode;
  readonly issueNumber?: number;
  readonly repository: string;
  readonly projectId?: string;
  readonly role?: WorkerAssignmentRole | string;
  readonly orcaArgs: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly adapter?: RuntimeAdapter;
  readonly execute?: (args: readonly string[]) => Promise<ChildResult>;
  readonly inspect?: (args: readonly string[]) => Promise<ChildResult>;
}): Promise<SupervisedWorkerStartResult> {
  const repository = input.repository.trim().toLowerCase();
  const role = parseWorkerAssignmentRole(input.role);
  const mode = input.mode ?? 'exact_terminal_worktree';
  if (mode !== 'exact_terminal_worktree' && mode !== 'provider_new_top_level') {
    return { ok: false, reason: 'supervised_start_mode_invalid' };
  }
  if (!repository
    || (input.issueNumber !== undefined
      && (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0))) {
    return { ok: false, reason: 'supervised_start_input_invalid' };
  }
  if (!role) {
    return { ok: false, reason: 'assignment_role_invalid' };
  }
  const args = [...input.orcaArgs];
  if (args.length === 0 || args[0] !== '--task' || !String(args[1] ?? '').trim()) {
    return { ok: false, reason: 'supervised_start_task_must_be_first' };
  }
  const requestedTaskId = String(args[1]).trim();
  const terminal = exactOption(args, '--terminal');
  const worktree = exactOption(args, '--worktree');
  if (mode === 'exact_terminal_worktree' && (!terminal || !worktree)) {
    return { ok: false, reason: 'supervised_start_exact_terminal_worktree_required' };
  }
  if (mode === 'provider_new_top_level'
    && (terminal || worktree !== 'new-top-level'
      || !providerOption(args, '--repo')?.startsWith('id:')
      || !providerOption(args, '--name')
      || providerOption(args, '--agent') !== 'cursor'
      || !providerOption(args, '--model')
      || !providerOption(args, '--effort')
      || providerOption(args, '--setup') !== 'run')) {
    return { ok: false, reason: 'supervised_start_provider_request_invalid' };
  }

  const file = resolveWorkerAssignmentStorePath(input.projectId, input.env ?? process.env);
  if (existsSync(file)) {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch {
      return { ok: false, reason: 'assignment_store_untrusted', cause: 'json_invalid' };
    }
    const inspected = inspectWorkerAssignmentStore(raw);
    if (!inspected.ok) {
      return { ok: false, reason: 'assignment_store_untrusted', cause: inspected.cause };
    }
  }
  const expectedCurrent = input.issueNumber === undefined
    ? null
    : currentWorkerAssignment(file, input.issueNumber);
  if (expectedCurrent?.repository !== undefined && expectedCurrent.repository !== repository) {
    return { ok: false, reason: 'assignment_stale' };
  }
  if (expectedCurrent && expectedCurrent.taskId !== requestedTaskId && expectedCurrent.kind !== 'local') {
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
  const placement = mode === 'exact_terminal_worktree'
    ? await resolvePlacementWitness({
      terminalSelector: terminal!,
      worktreeSelector: worktree!,
      inspect,
    })
    : { ok: true as const, witness: undefined };
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
    if (!isRecord(parsed)) {
      return rejectedStart('supervised_start_receipt_invalid');
    }
    const errorRecord = isRecord(parsed.error) ? parsed.error : null;
    const errorCode = nonEmpty(errorRecord?.code);
    const recovery = recoveryEvidence(errorRecord);
    if (!isRecord(parsed.result)) {
      return errorCode
        ? rejectedStart('supervised_start_envelope_error', undefined, errorCode, recovery)
        : rejectedStart('supervised_start_receipt_invalid');
    }
    envelope = parsed as OrcaWorkerStartEnvelope;
  } catch {
    return rejectedStart('supervised_start_receipt_invalid');
  }
  const receipt = envelope.result as SupervisedWorkerStartReceipt;
  const errorCode = nonEmpty(envelope.error?.code);
  const recovery = recoveryEvidence(envelope.error);
  if (envelope.ok !== true) {
    return rejectedStart('supervised_start_envelope_not_ok', receipt, errorCode || undefined, recovery);
  }
  if (!execution.ok || receipt.state !== 'ready') {
    return rejectedStart(`supervised_start_${receipt.state || 'failed'}`, receipt, errorCode || undefined, recovery);
  }
  const taskId = String(receipt.taskId ?? '').trim();
  const dispatchId = String(receipt.dispatchId ?? '').trim();
  if (!taskId || !dispatchId) {
    return rejectedStart('supervised_start_identity_missing', receipt);
  }
  if (taskId !== requestedTaskId) {
    return rejectedStart('supervised_start_task_mismatch', receipt);
  }
  const placementReason = mode === 'exact_terminal_worktree'
    ? validateReceiptPlacement(receipt, placement.witness!)
    : validateProviderTopLevelReceipt(receipt, args);
  if (placementReason) return rejectedStart(placementReason, receipt);

  const publishBase = {
    file,
    projectId: input.projectId,
    repository,
    taskId,
    kind: 'local' as const,
    provider: 'orca',
    bindingKey: dispatchId,
    expectedCurrent: expectedCurrentForPublish(expectedCurrent),
    role,
  };
  const published = input.issueNumber === undefined
    ? await publishCurrentWorkerAssignment(publishBase)
    : await publishCurrentWorkerAssignment({ ...publishBase, issueNumber: input.issueNumber });
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
    return rejectedStart(published.reason, receipt, undefined, undefined, published.cause);
  }
  return { ok: true, reason: 'ready_and_assignment_bound', receipt, assignment: published.assignment };
}

export async function attachSupervisedWorkerIssue(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly assignmentId: string;
  readonly generation: number;
  readonly projectId?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<SupervisedWorkerIssueAttachResult> {
  const repository = input.repository.trim().toLowerCase();
  const taskId = input.taskId.trim();
  const dispatchId = input.dispatchId.trim();
  const assignmentId = input.assignmentId.trim();
  if (!repository || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0
    || !taskId || !dispatchId || !assignmentId
    || !Number.isInteger(input.generation) || input.generation <= 0) {
    return { ok: false, reason: 'assignment_input_invalid' };
  }
  const file = resolveWorkerAssignmentStorePath(input.projectId, input.env ?? process.env);
  const current = currentWorkerAssignmentByDeliverable(file, taskId, dispatchId);
  if (!current
    || current.repository !== repository
    || current.assignmentId !== assignmentId
    || current.generation !== input.generation) {
    return { ok: false, reason: 'assignment_stale' };
  }
  const attached = await attachWorkerAssignmentIssueNumber({
    file,
    expected: current,
    issueNumber: input.issueNumber,
  });
  if (!attached.ok) return attached;
  return { ok: true, reason: 'issue_metadata_attached', assignment: attached.assignment };
}

function optionValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? '').trim() : '';
}

function countFlag(args: readonly string[], name: string): number {
  return args.filter((arg) => arg === name).length;
}

function parseStartCli(argv: readonly string[]): {
  mode?: WorkerStartMode;
  issueNumber?: number;
  repository: string;
  projectId?: string;
  role?: string;
  orcaArgs: string[];
} {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('usage: supervised-worker-start [--issue-number N] --repository owner/repo [--project-id id] --role worker|orchestrator -- --task task_id --terminal handle --worktree selector ...');
  const own = argv.slice(0, separator);
  const orcaArgs = argv.slice(separator + 1);
  if (countFlag(own, '--role') !== 1) {
    throw new Error('exactly one --role worker|orchestrator is required');
  }
  if (countFlag(own, '--mode') > 1) throw new Error('at most one --mode is allowed');
  const modeRaw = optionValue(own, '--mode');
  if (modeRaw && modeRaw !== 'exact_terminal_worktree' && modeRaw !== 'provider_new_top_level') {
    throw new Error('--mode must be exact_terminal_worktree|provider_new_top_level');
  }
  const issueNumberRaw = optionValue(own, '--issue-number');
  return {
    ...(optionValue(own, '--mode') ? { mode: optionValue(own, '--mode') as WorkerStartMode } : {}),
    ...(issueNumberRaw ? { issueNumber: Number(issueNumberRaw) } : {}),
    repository: optionValue(own, '--repository'),
    ...(optionValue(own, '--project-id') ? { projectId: optionValue(own, '--project-id') } : {}),
    role: optionValue(own, '--role'),
    orcaArgs,
  };
}

function parseAttachCli(argv: readonly string[]): Parameters<typeof attachSupervisedWorkerIssue>[0] {
  const projectId = optionValue(argv, '--project-id');
  return {
    repository: optionValue(argv, '--repository'),
    issueNumber: Number(optionValue(argv, '--issue-number')),
    taskId: optionValue(argv, '--task-id'),
    dispatchId: optionValue(argv, '--dispatch-id'),
    assignmentId: optionValue(argv, '--assignment-id'),
    generation: Number(optionValue(argv, '--generation')),
    ...(projectId ? { projectId } : {}),
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const result = argv[0] === 'attach-issue'
    ? await attachSupervisedWorkerIssue(parseAttachCli(argv.slice(1)))
    : await runSupervisedWorkerStart(parseStartCli(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('supervised-worker-start.ts')) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
