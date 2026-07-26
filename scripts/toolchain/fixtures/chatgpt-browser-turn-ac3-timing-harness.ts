import { performance } from 'node:perf_hooks';
import { fakeTurnPage } from '../../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { sendTurn } from '../../chatgpt-browser-turn/ui-adapter.ts';

const POST_STDOUT_CLEANUP_MS = 1_500;

async function main(): Promise<void> {
  const started = performance.now();
  const marks: Record<string, number> = {};

  process.env.CHATGPT_BROWSER_TURN_DELIVERED_DEADLINE_MS = '50';

  const fixture = fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
  });

  const originalContext = fixture.page.context;
  fixture.page.context = () => ({
    newCDPSession: async () => ({
      send: async () => {},
      on: () => {},
      off: () => {},
      detach: async () => {
        await new Promise<void>(() => {
          const timer = setTimeout(() => {}, 60_000);
          timer.unref();
        });
      },
    }),
  });

  const result = await sendTurn(fixture.page, 'payload', {
    cdp: 'http://127.0.0.1:9222',
    profile: 'automation',
    chatUrl: 'https://chatgpt.com/c/example',
    newChat: false,
    timeoutMs: 60_000,
  });
  fixture.page.context = originalContext;

  marks.result_produced_ms = performance.now() - started;
  process.stdout.write(`${JSON.stringify({ state: result.state, cause: result.cause })}\n`);
  marks.stdout_written_ms = performance.now() - started;

  await new Promise<void>((resolve) => { setTimeout(resolve, POST_STDOUT_CLEANUP_MS); });
  marks.post_stdout_cleanup_ms = performance.now() - started;

  process.stderr.write(`${JSON.stringify({ timing_marks: marks })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ harness_error: message })}\n`);
  process.exitCode = 1;
});
