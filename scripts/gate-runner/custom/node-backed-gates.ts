import { runProcessSync, type ProcessResult } from '#opk-kernel/subprocess';
import { failGate, passGate, skipGate, type EvidenceObservation, type GateResult } from '../contracts.ts';
import type { GateEvaluationContext, GateRegistration } from '../registry.ts';

export interface NodeGateCommand {
  readonly gateId: string;
  readonly summary: string;
  readonly script: string;
  readonly args: (repoRoot: string) => readonly string[];
  readonly legacyStdout?: string;
  readonly successSuffix?: string;
  readonly failureSuffix?: string;
}

export type NodeGateProcessRunner = (command: string, args: readonly string[], cwd: string) => ProcessResult;

const defaultProcessRunner: NodeGateProcessRunner = (command, args, cwd) => runProcessSync({
  command,
  args,
  cwd,
  inheritParentEnv: true,
});


function completedLegacyStdout(command: NodeGateCommand, result: ProcessResult, success: boolean): string | undefined {
  const base = result.stdout || (success ? command.legacyStdout ?? '' : '');
  const suffix = success ? command.successSuffix ?? '' : command.failureSuffix ?? '';
  const output = `${base}${suffix}`;
  return output.length > 0 ? output : undefined;
}

function liveEvidence(command: NodeGateCommand, state: EvidenceObservation['state'], detail?: string): EvidenceObservation[] {
  return [{ class: 'live-adoption', state, source: command.script, detail }];
}

export function evaluateNodeBackedGate(
  command: NodeGateCommand,
  repoRoot: string,
  processRunner: NodeGateProcessRunner = defaultProcessRunner,
): GateResult {
  const result = processRunner('node', [command.script, ...command.args(repoRoot)], repoRoot);
  if (result.outcome === 'spawn-failure') {
    return skipGate(
      command.gateId,
      `${command.summary} Node execution was unavailable.`,
      liveEvidence(command, 'unreachable', result.error ?? (result.stderr || 'node spawn failed')),
      [result.error ?? (result.stderr || 'node spawn failed')],
      false,
      result.stdout || command.legacyStdout,
    );
  }
  if (result.outcome !== 'exit') {
    return skipGate(
      command.gateId,
      `${command.summary} Node execution did not reach a normal exit.`,
      liveEvidence(command, 'unreachable', `${result.outcome}${result.signal ? ` (${result.signal})` : ''}`),
      [`process outcome=${result.outcome}${result.signal ? ` signal=${result.signal}` : ''}`],
      false,
      result.stdout || command.legacyStdout,
    );
  }
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) {
    return failGate(
      command.gateId,
      command.summary,
      liveEvidence(command, 'present'),
      [output.trim() || `node process exited ${String(result.exitCode)}`],
      completedLegacyStdout(command, result, false),
    );
  }
  return passGate(
    command.gateId,
    command.summary,
    ['live-adoption'],
    liveEvidence(command, 'present'),
    { legacyStdout: completedLegacyStdout(command, result, true) },
  );
}

export const nodeBackedGateCommands: readonly NodeGateCommand[] = [
  {
    gateId: 'external-output-shape-guard',
    summary: 'External-tool output fixture shape contract',
    script: 'scripts/external-output-shape-guard.mjs',
    args: (repoRoot) => ['--repo-root', repoRoot],
    legacyStdout: '[PASS] external-output shape guard (Issue #223)\n',
  },
  {
    gateId: 'launch-argv-inventory',
    summary: 'Pack-wide launch-argv contract inventory',
    script: 'docs/generated-launch-argv-inventory.mjs',
    args: (repoRoot) => [repoRoot],
    successSuffix: '[PASS] launch-argv inventory guard (Issue #661)\n',
    failureSuffix: '[FAIL] launch-argv inventory guard (Issue #661)\n',
  },
] as const;

export const nodeBackedGateRegistrations: readonly GateRegistration[] = nodeBackedGateCommands.map(
  (command): GateRegistration => ({
    gateId: command.gateId,
    evaluate: ({ repoRoot }: GateEvaluationContext) => evaluateNodeBackedGate(command, repoRoot),
  }),
);
