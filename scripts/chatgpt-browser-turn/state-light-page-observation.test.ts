import { describe, expect, it, vi } from 'vitest';

import {
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  matchesStopButtonSelector,
} from './product-page-selectors.ts';
import { scalarLocator } from './state-light-turn.test-fixtures.ts';
import {
  classifyPageObservation,
  ownedPromptMatches,
  replyStabilityMatches,
  replyStabilityFingerprint,
} from './state-light-turn.ts';

function makeTurnContainerPage(options: {
  assistantText: string;
  actionButtonsInTurn: boolean;
  generating?: boolean;
}) {
  const assistant = scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'assistant';
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
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistants;
      if (matchesStopButtonSelector(selector)) return scalarLocator();
      return scalarLocator();
    }),
    getByText: vi.fn(() => scalarLocator()),
    getByRole: vi.fn(() => scalarLocator()),
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

  it('waits on truncated lazy-render of the owned prompt until the full echo appears', () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const truncatedEcho = `${'A'.repeat(20)}`;

    expect(ownedPromptMatches(truncatedEcho, longPrompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncatedEcho }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });

    const fullEcho = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    expect(ownedPromptMatches(fullEcho, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: fullEcho }, { role: 'assistant', text: 'FINAL', }],
      baseline.length,
      longPrompt,
      false,
    )).toEqual({ state: 'ready', reply: 'FINAL' });
  });

  it('treats a transient duplicate owned user render as waiting, not uncertain', () => {
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

  it('finds the last owned user node even when baseline count includes it', () => {
    const continuation = [
      { role: 'user' as const, text: 'USER-ONE' },
      { role: 'assistant' as const, text: 'ANSWER-ONE' },
      { role: 'user' as const, text: 'USER-TWO' },
      { role: 'assistant' as const, text: 'ANSWER-TWO' },
      { role: 'user' as const, text: 'PROMPT' },
      { role: 'assistant' as const, text: 'FINAL' },
    ];
    const lateBaselineCount = continuation.length - 1;

    expect(classifyPageObservation(
      continuation,
      lateBaselineCount,
      'PROMPT',
      false,
    )).toEqual({ state: 'ready', reply: 'FINAL' });
  });

  it('captures the owned reply before a later foreign user turn', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'OWNED ANSWER' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER' },
      ],
      baseline.length,
      'PROMPT',
      false,
    )).toEqual({ state: 'ready', reply: 'OWNED ANSWER' });
  });

  it('flags genuinely foreign user text as uncertain when no owned reply is ready', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({
      state: 'uncertain',
      cause: 'foreign_user_after_owned_send',
      observedUserHeads: ['FOREIGN'],
    });
  });

  it('never publishes a partial owned reply when a later foreign turn completed', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'PARTIAL' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN COMPLETE' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({
      state: 'uncertain',
      cause: 'foreign_user_after_owned_send',
      observedUserHeads: ['FOREIGN'],
    });
  });

  it('matches owned text when markdown and line breaking normalize to the same string', () => {
    const longPrompt = `Problem:\nFlow-manager misclassifies.\n\nGoal:\nFix echo matching.\n${'detail '.repeat(80)}`;
    const rendered = `Problem: Flow-manager misclassifies. Goal: Fix echo matching. ${'detail '.repeat(80)}`.trim();

    expect(ownedPromptMatches(rendered, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: rendered }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('rejects partial windows that are not the full normalized prompt', () => {
    const longPrompt = `PREFIX ${'alpha '.repeat(100)}MIDDLE ${'beta '.repeat(100)}SUFFIX`;
    const middleWindow = 'MIDDLE beta beta beta';

    expect(ownedPromptMatches(middleWindow, longPrompt)).toBe(false);
  });

  it('matches owned text only after UI collapse affixes are stripped', () => {
    const prompt = 'Line one. Line two with enough content to exceed minimum overlap requirements for the matcher.';
    const visible = 'Line one. Line two with enough content to exceed minimum overlap requirements for the matcher.';

    expect(ownedPromptMatches(visible, prompt)).toBe(true);
    expect(ownedPromptMatches('Line one. Line two with enough content show more', prompt)).toBe(false);
  });

  it('returns promptly for long genuinely foreign visible text', () => {
    const prompt = `owned ${'detail '.repeat(500)}`;
    const foreign = `FOREIGN ${'noise '.repeat(300)}`;
    const started = performance.now();
    expect(ownedPromptMatches(foreign, prompt)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('accepts a long markdown prompt when the rendered visible text normalizes to the same string', () => {
    const body = Array.from({ length: 520 }, () => 'detail').join(' ');
    const longPrompt = `# Issue #1120 pulse\n\n## OUTPUT CONSTRAINTS\n- Keep answer under 500 words\n- Use \`backticks\` sparingly\n\n${body}`;
    const renderedVisible = `Issue #1120 pulse OUTPUT CONSTRAINTS Keep answer under 500 words Use backticks sparingly ${body}`;

    expect(longPrompt.length).toBeGreaterThanOrEqual(3000);
    expect(renderedVisible.length).toBeGreaterThanOrEqual(3000);
    expect(ownedPromptMatches(renderedVisible, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: renderedVisible }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('does not treat genuinely foreign long markdown-adjacent text as owned', () => {
    const prompt = `# Owned\n\n${'owned detail '.repeat(300)}`;
    const foreign = `FOREIGN INTERLOPER ${'noise '.repeat(500)}`;

    expect(prompt.length).toBeGreaterThanOrEqual(3000);
    expect(foreign.length).toBeGreaterThanOrEqual(3000);
    expect(ownedPromptMatches(foreign, prompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: foreign }, { role: 'assistant', text: 'working' }],
      baseline.length,
      prompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('rejects textContent with sr-only prefix while rendered innerText matches', () => {
    const prompt = 'Issue #1120 strict-matcher smoke cell OUTPUT CONSTRAINTS Keep answer under 500 words';
    const rendered = prompt;
    const textContentWithSrOnly = `You said: ${rendered}`;

    expect(ownedPromptMatches(rendered, prompt)).toBe(true);
    expect(ownedPromptMatches(textContentWithSrOnly, prompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: rendered }, { role: 'assistant', text: 'working' }],
      baseline.length,
      prompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('keeps short prompt strict equality unchanged', () => {
    const prompt = 'PROMPT-SHORT owned echo baseline';
    const visible = 'PROMPT-SHORT owned echo baseline';

    expect(ownedPromptMatches(visible, prompt)).toBe(true);
  });

  it('keeps genuinely unrelated text non-owned', () => {
    const prompt = `owned ${'detail '.repeat(80)}`;
    expect(ownedPromptMatches('FOREIGN INTERLOPER TEXT', prompt)).toBe(false);
  });

  it('does not classify owned truncated renderings as uncertain', () => {
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
  });

  it('never publishes a foreign answer when the owned prompt is not recognized', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PARTIAL-OWNED' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER' },
      ],
      baseline.length,
      'FULL-OWNED-PROMPT',
      false,
    )).toEqual({ state: 'waiting' });
  });

  it('treats render-different assistant reads as stable when normalized text matches', () => {
    const body = `${'detail '.repeat(60)} Section footer with enough words.`;
    const renderA = `Intro paragraph.\n\n${body}`;
    const renderB = `Intro paragraph. ${body} show more`;

    expect(replyStabilityMatches(renderB, renderA)).toBe(true);
    expect(replyStabilityMatches(`${renderA} extra tail`, renderA)).toBe(false);
  });

  it('treats large mid-body length swings as stable when head and tail fingerprints match', () => {
    const head = `INTRO ${'A'.repeat(180)}`;
    const tail = `${'Z'.repeat(180)} OUTRO`;
    const longRead = `${head}${'M'.repeat(4500)}${tail}`;
    const shortRead = `${head}${'M'.repeat(200)}${tail}`;

    expect(replyStabilityFingerprint(longRead)).toBe(replyStabilityFingerprint(shortRead));
    expect(replyStabilityMatches(longRead, shortRead)).toBe(true);
    expect(longRead.length - shortRead.length).toBeGreaterThan(1000);
  });
});
