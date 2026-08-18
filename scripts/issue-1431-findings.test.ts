import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readManagerReviewCanon,
  renderManagerReviewBrief,
  type ManagerReviewBriefContext,
} from './lib/manager-review-brief.ts';
import { runStateLightEntry } from './chatgpt-browser-turn/state-light-entry.ts';
import { runCli as runLegacyBrowserTurnCli } from './chatgpt-browser-turn.ts';

const reviewContext: ManagerReviewBriefContext = {
  repositoryFullName: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1431,
  sourceRevision: 'r07',
  stage: 'architectural-review',
  sourceSlot: '01',
  invocationId: '11111111-2222-4333-8444-555555555555',
};

function optionValue(argv: readonly string[], key: string): string | undefined {
  const index = argv.indexOf(`--${key}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function captureWrite(stream: NodeJS.WriteStream): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, 'write');
  spy.mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write);
  return { chunks, restore: () => spy.mockRestore() };
}

describe('Issue #1431 review finding regressions', () => {
  it('pins the admitted canonical snapshot across caller input replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-pinned-'));
    try {
      const input = join(root, 'review.txt');
      const rendered = renderManagerReviewBrief(readManagerReviewCanon(), reviewContext);
      writeFileSync(input, rendered.text);
      let delegatedInput: string | undefined;

      const code = await runStateLightEntry([
        'turn',
        '--invocation-id', reviewContext.invocationId,
        '--input', input,
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', reviewContext.repositoryFullName,
        '--issue-number', String(reviewContext.issueNumber),
        '--source-revision', reviewContext.sourceRevision,
        '--stage', reviewContext.stage,
        '--source-slot', reviewContext.sourceSlot,
      ], {
        runTurn: async (argv) => {
          delegatedInput = optionValue(argv, 'input');
          expect(delegatedInput).toBeDefined();
          expect(delegatedInput).not.toBe(input);

          // Reproduce the former inter-read race after entry admission but before
          // the downstream transport consumes its input path.
          writeFileSync(input, `${rendered.text}mutation\n`);
          expect(readFileSync(delegatedInput!, 'utf8')).toBe(rendered.text);
          expect(argv).not.toContain('--stage');
          expect(argv).not.toContain('--source-slot');
          return 0;
        },
      });

      expect(code).toBe(0);
      expect(delegatedInput).toBeDefined();
      expect(existsSync(delegatedInput!)).toBe(false);
      expect(readFileSync(input, 'utf8')).toContain('mutation');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses legacy direct publication before the capture branch can run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-legacy-'));
    const stdout = captureWrite(process.stdout);
    try {
      expect(await runLegacyBrowserTurnCli([
        'turn',
        '--invocation-id', reviewContext.invocationId,
        '--capture-too-many-requests-source', join(root, 'capture.html'),
        '--reviewer-source-output', join(root, 'source.txt'),
      ])).not.toBe(0);

      const refusal = JSON.parse(stdout.chunks.join('').trim()) as {
        schema: string;
        state: string;
        cause: string;
        send_count: number;
      };
      expect(refusal.schema).toBe('turn-result/v1');
      expect(refusal.state).toBe('input_invalid');
      expect(refusal.cause).toBe('input_invalid:legacy_direct_publication_turn_refused');
      expect(refusal.send_count).toBe(0);
      expect(existsSync(join(root, 'capture.html'))).toBe(false);
    } finally {
      stdout.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
