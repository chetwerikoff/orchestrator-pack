import { describe, expect, it, vi } from 'vitest';

import {
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';
import { scalarLocator } from './state-light-turn.test-fixtures.ts';
import {
  buildForeignActivityDiagnostics,
  classifyPageObservation,
  foreignSuspectEvidenceFingerprint,
  ownedPromptEchoMatches,
  promptEchoSharedOverlap,
} from './state-light-turn.ts';

function makeTurnContainerPage(options: {
  assistantText: string;
  actionButtonsInTurn: boolean;
  generating?: boolean;
}) {
  const assistant = scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === 'data-message-author-role') return 'assistant';
      if (name === 'data-is-streaming') return options.generating ? 'true' : null;
      return null;
    }),
    innerText: vi.fn(async () => options.assistantText),
    locator: vi.fn((selector: string) => {
      if (selector.startsWith('xpath=')) {
        return options.actionButtonsInTurn
          ? scalarLocator({ turnActionButtons: true, count: vi.fn(async () => 1) })
          : scalarLocator({ count: vi.fn(async () => 0) });
      }
      return scalarLocator();
    }),
  });
  const assistants = scalarLocator({
    count: vi.fn(async () => 1),
    nth: vi.fn(() => assistant),
  });
  return {
    locator: vi.fn((selector: string) => {
      if (selector === '[data-message-author-role="assistant"]') return assistants;
      if (selector.includes('stop-button')) return scalarLocator();
      return scalarLocator();
    }),
    getByText: vi.fn(() => scalarLocator()),
  };
}

describe('state-light page observation driver', () => {
  it('treats turn-container action buttons as completion-ready even when absent from the assistant node', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: true,
    });

    await expect(readAssistantTurnGenerating(page)).resolves.toBe(false);
    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(true);
  });

  it('stays waiting when action buttons are missing from both assistant and turn container', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: false,
    });

    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(false);
  });
});

describe('state-light prompt attribution classification', () => {
  const baseline = [
    { role: 'user' as const, text: 'OLD' },
    { role: 'assistant' as const, text: 'OLD ANSWER' },
  ];

  it('accepts a collapsed long prompt echo as owned rather than foreign', () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const collapsedEcho = `${'A'.repeat(120)} detail detail detail…`;

    expect(ownedPromptEchoMatches(collapsedEcho, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('treats a transient duplicate owned user render as waiting, not foreign', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'working' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('flags genuinely foreign user text as foreign_suspect for stable promotion', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
      ],
      baseline.length,
      'PROMPT',
      false,
    )).toEqual({
      state: 'foreign_suspect',
      cause: 'foreign_user_after_owned_send',
      suspectFingerprint: 'FOREIGN',
    });
  });

  it('matches collapsed render with different line breaking than the source prompt', () => {
    const longPrompt = `Problem:\nFlow-manager misclassifies.\n\nGoal:\nFix echo matching.\n${'detail '.repeat(80)}`;
    const collapsedEcho = 'Problem: Flow-manager misclassifies. Goal: Fix echo matching. detail detail…';

    expect(ownedPromptEchoMatches(collapsedEcho, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('matches a visible window from the middle of the prompt', () => {
    const longPrompt = `PREFIX ${'alpha '.repeat(100)}MIDDLE ${'beta '.repeat(100)}SUFFIX`;
    const middleWindow = 'MIDDLE beta beta beta';

    expect(ownedPromptEchoMatches(middleWindow, longPrompt)).toBe(true);
    expect(promptEchoSharedOverlap(middleWindow, longPrompt)).toBeGreaterThanOrEqual(16);
  });

  it('matches owned text with a UI collapse affix appended', () => {
    const prompt = 'Line one.\n\nLine two with enough content to exceed minimum overlap requirements for the matcher.';
    const visible = 'Line one. Line two with enough content show more';

    expect(ownedPromptEchoMatches(visible, prompt)).toBe(true);
  });


  it('returns promptly for long genuinely foreign visible text', () => {
    const prompt = `owned ${'detail '.repeat(500)}`;
    const foreign = `FOREIGN ${'noise '.repeat(300)}`;
    const started = performance.now();
    expect(ownedPromptEchoMatches(foreign, prompt)).toBe(false);
    expect(promptEchoSharedOverlap(foreign, prompt)).toBeLessThan(16);
    expect(performance.now() - started).toBeLessThan(50);
  });
  it('keeps genuinely unrelated text foreign', () => {
    const prompt = `owned ${'detail '.repeat(80)}`;
    expect(ownedPromptEchoMatches('FOREIGN INTERLOPER TEXT', prompt)).toBe(false);
    expect(buildForeignActivityDiagnostics('FOREIGN INTERLOPER TEXT', prompt).shared_overlap).toBeLessThan(24);
  });

  it('does not classify owned truncated renderings as foreign_suspect', () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const truncA = `${'A'.repeat(20)}`;
    const truncB = `${'A'.repeat(30)}`;

    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncA }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncB }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
    expect(foreignSuspectEvidenceFingerprint(
      [...baseline, { role: 'user', text: truncA }],
      baseline.length,
      longPrompt,
    )).toBe('');
  });
});
