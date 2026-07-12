/** Orchestrator review-pipeline aggregate spawn budget (Issue #480). */
import { readStdinJson } from './review-mechanical-cli.mjs';
import { attributeSpawnSourceClass } from './review-pipeline-spawn-budget-attribution.mjs';
import {
  buildSpawnBudgetReport,
  evaluateSpawnBudgetReport,
  replayCaptureBudgetCheck,
  verifyCommittedCaptureReplays,
} from './review-pipeline-spawn-budget-evidence.mjs';

export * from './review-pipeline-spawn-budget-attribution.mjs';
export * from './review-pipeline-spawn-budget-evidence.mjs';

const cliSubcommands = {
  attribute: () => {
    const input = readStdinJson();
    return { sourceClass: attributeSpawnSourceClass(input.commandLine, input) };
  },
  report: () => {
    const input = readStdinJson();
    return buildSpawnBudgetReport(input.capture, input.budget ?? {});
  },
  evaluate: () => {
    const input = readStdinJson();
    const report = buildSpawnBudgetReport(input.capture, input.budget ?? {});
    return { report, verdict: evaluateSpawnBudgetReport(report) };
  },
  replay: () => {
    const input = readStdinJson();
    return replayCaptureBudgetCheck(input.capture, input.budget ?? {}, input.expectedCaseId);
  },
  verifyCaptures: () => {
    const input = readStdinJson();
    return verifyCommittedCaptureReplays(input.packRoot ?? '.', input.budget);
  },
};

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const subcommand = process.argv[2] ?? '';
  const handler = cliSubcommands[subcommand];
  if (!handler) {
    console.error(`unknown subcommand: ${subcommand}`);
    process.exit(2);
  }
  const result = handler();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    process.exit(1);
  }
}
