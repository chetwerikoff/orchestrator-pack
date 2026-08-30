import '../../../scripts/toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeReview } from '../lib/review_core.ts';
import { parseReviewArgs } from '../lib/review_cli.ts';
import { createReviewerBudgetLedger } from '../lib/reviewer_budget.ts';
import { runProcess } from '../../../scripts/kernel/subprocess.ts';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runClaudePackReview(argv: string[]): Promise<number> {
  let options: ReturnType<typeof parseReviewArgs>;
  try {
    options = parseReviewArgs(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return 2;
  }

  if (options.promptOnly) {
    process.stderr.write('Claude pack-review adapter does not accept --prompt-only\n');
    return 2;
  }

  const budget = createReviewerBudgetLedger();
  const promptResult = executeReview({
    ...options,
    fixtureStdout: undefined,
    skipCodex: true,
  });
  if (promptResult.exitCode !== 0 || !promptResult.reviewStdout.trim()) {
    for (const line of promptResult.logLines) process.stderr.write(`${line}\n`);
    return promptResult.exitCode || 1;
  }

  const claude = await runProcess({
    command: 'claude',
    args: ['--print', '--model', options.model ?? DEFAULT_CLAUDE_MODEL],
    cwd: options.repoRoot,
    inheritParentEnv: true,
    input: promptResult.reviewStdout,
    allowEmptyStdout: false,
    timeoutMs: budget.effectiveBudgetMs,
    onSpawn: (pid) => {
      const runId = String(process.env.PACK_REVIEW_RUN_ID ?? process.env.OPK_REVIEW_RUN_ID ?? '').trim();
      process.stderr.write(`OPK_NATIVE_CHILD_V1 ${JSON.stringify({
        schema: 'pack-review-native-child/v1',
        runId,
        reviewer: 'claude',
        pid,
        ...(process.platform === 'win32' ? {} : { processGroupId: pid }),
        startedAtUtc: new Date().toISOString(),
      })}\n`);
    },
  });
  if (!claude.ok) {
    if (claude.stderr) process.stderr.write(claude.stderr.endsWith('\n') ? claude.stderr : `${claude.stderr}\n`);
    if (claude.error) process.stderr.write(`${claude.error}\n`);
    return claude.exitCode ?? 1;
  }

  const parsed = executeReview({
    ...options,
    skipCodex: false,
    fixtureStdout: claude.stdout,
  });
  for (const line of parsed.logLines) process.stderr.write(`${line}\n`);
  if (parsed.reviewStdout) {
    process.stdout.write(parsed.reviewStdout);
    if (!parsed.reviewStdout.endsWith('\n')) process.stdout.write('\n');
  }
  return parsed.exitCode;
}

const direct = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;
if (direct) {
  try {
    process.exitCode = await runClaudePackReview(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
