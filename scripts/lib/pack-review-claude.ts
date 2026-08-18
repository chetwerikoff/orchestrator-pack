import '../toolchain/native-entrypoint-preflight.ts';
import { executeReview } from '../../plugins/codex-pr-reviewer/lib/review_core.ts';
import { parseReviewArgs } from '../../plugins/codex-pr-reviewer/lib/review_cli.ts';
import { runProcess } from '../kernel/subprocess.ts';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await runClaudePackReview(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
