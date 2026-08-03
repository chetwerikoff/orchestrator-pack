import type { ProcessResult } from '../kernel/subprocess.ts';
import { asRuntimeObservationToken, type RuntimeBoundedOutput } from '../runtime/contracts.ts';
import {
  object,
  opaqueHash,
  parseBoundedOutputPayload,
} from './mapping.ts';
import { resolveOrcaExecutable } from './transport.ts';

export type OrcaProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number; readonly input: string },
) => Promise<ProcessResult>;

export type LegacyOrcaBoundedRead =
  | {
    readonly status: 'ok';
    readonly output: RuntimeBoundedOutput;
    readonly evidence: Record<string, unknown>;
  }
  | {
    readonly status: 'deadline';
    readonly evidence: Record<string, unknown>;
  }
  | {
    readonly status: 'source-unavailable';
    readonly reasonCode:
      | 'orca_read_ok_false'
      | 'orca_read_command_failed'
      | 'orca_read_empty_stdout'
      | 'orca_read_malformed_json'
      | 'orca_read_invalid_response_shape';
    readonly evidence: Record<string, unknown>;
  };

function processEvidence(result: ProcessResult): Record<string, unknown> {
  return {
    processOutcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stderr: result.stderr,
    error: result.error,
  };
}

export async function readLegacyOrcaBoundedOutputWithRunner(input: {
  readonly handle: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly runner: OrcaProcessRunner;
  readonly executable?: string;
}): Promise<LegacyOrcaBoundedRead> {
  let result: ProcessResult;
  try {
    result = await input.runner(
      input.executable ?? resolveOrcaExecutable(),
      ['terminal', 'read', '--terminal', input.handle, '--json'],
      { cwd: input.cwd, timeoutMs: input.timeoutMs, input: '' },
    );
  } catch (error) {
    result = {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const evidence = processEvidence(result);
  if (result.timedOut || result.outcome === 'timeout') return { status: 'deadline', evidence };
  const stdout = result.stdout.trim();
  let payload: Record<string, unknown> | null = null;
  let malformed = false;
  if (stdout) {
    try {
      payload = object(JSON.parse(stdout) as unknown);
      malformed = payload === null;
    } catch {
      malformed = true;
    }
  }
  if (payload?.ok === false) {
    return {
      status: 'source-unavailable',
      reasonCode: 'orca_read_ok_false',
      evidence: { ...evidence, response: payload },
    };
  }
  if (!result.ok) {
    return { status: 'source-unavailable', reasonCode: 'orca_read_command_failed', evidence };
  }
  if (!stdout) {
    return { status: 'source-unavailable', reasonCode: 'orca_read_empty_stdout', evidence };
  }
  if (malformed || !payload) {
    return { status: 'source-unavailable', reasonCode: 'orca_read_malformed_json', evidence };
  }
  const parsed = parseBoundedOutputPayload(payload.result);
  if (!parsed.ok) {
    return {
      status: 'source-unavailable',
      reasonCode: 'orca_read_invalid_response_shape',
      evidence: { ...evidence, response: payload },
    };
  }
  const observationToken = asRuntimeObservationToken(
    opaqueHash('observation', `${input.handle}\u0000${String(parsed.nativeCursor)}`),
  );
  return {
    status: 'ok',
    output: { lines: parsed.lines, observationToken, changed: parsed.lines.length > 0 },
    evidence: { response: payload },
  };
}
