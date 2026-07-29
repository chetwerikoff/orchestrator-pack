import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPageObservation } from '../browser-gpt-turn.ts';

const helperSource = readFileSync(resolve(process.cwd(), 'scripts/browser-gpt-turn.ts'), 'utf8');

describe('Issue #1120 Browser-GPT turn cutover', () => {
  it('accepts one final page reply without service-terminal evidence', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'review PR 1120' },
      { role: 'assistant', text: 'final answer' },
    ], 2, 'review PR 1120', false)).toEqual({ state: 'ready', reply: 'final answer' });
  });

  it('returns only the last assistant node for multi-node same-turn output', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'I am checking the repository.' },
      { role: 'assistant', text: 'progress: tests inspected' },
      { role: 'assistant', text: 'NO_FINDINGS' },
    ], 0, 'task', false)).toEqual({ state: 'ready', reply: 'NO_FINDINGS' });
  });

  it('never treats a non-empty intermediate reply as complete while generation is active', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial answer' },
    ], 0, 'task', true)).toEqual({ state: 'waiting' });
  });

  it('fails only the invocation when foreign/interleaved user activity appears', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial' },
      { role: 'user', text: 'foreign task' },
      { role: 'assistant', text: 'foreign answer' },
    ], 0, 'task', false)).toEqual({
      state: 'foreign_activity',
      cause: 'foreign_or_ambiguous_user_activity',
    });
  });

  it('does not claim a reply until its own prompt appears after the baseline', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'assistant', text: 'unattributed text' },
    ], 2, 'new prompt', false)).toEqual({ state: 'waiting' });
  });

  it('keeps the live turn path free of old admission/recovery authority', () => {
    for (const forbidden of [
      'acquireDomainLock(',
      'reserveDestination(',
      'blockerBeforeSend(',
      'statusList(',
      'capabilityStatus(',
      'runtimeWitnessSurfaceAvailable(',
      'runGateBCharacterization(',
      "cause: 'reply_finished_terminal_unproven'",
    ]) {
      expect(helperSource, forbidden).not.toContain(forbidden);
    }
  });

  it('creates a fresh owned tab and has exactly one user-message mutation site', () => {
    expect(helperSource).toContain('contexts[0].newPage()');
    expect(helperSource).not.toContain('ctx.pages().find');
    const sendButtonClicks = helperSource.match(/sendButton\.click\(/g) ?? [];
    const composerEnterPresses = helperSource.match(/composer\.press\('Enter'/g) ?? [];
    expect(sendButtonClicks).toHaveLength(1);
    expect(composerEnterPresses).toHaveLength(1);
    expect(helperSource).toContain('sendCount = 1');
  });

  it('keeps recurrence logging append-only and off the normal waiting path', () => {
    expect(helperSource).toContain("appendFileSync(BROWSER_TURN_RECURRENCE_PATH");
    expect(helperSource).not.toMatch(/readFileSync\(BROWSER_TURN_RECURRENCE_PATH/);
    expect(helperSource).not.toMatch(/acquire.*journal|journal.*lock/i);
    expect(helperSource).not.toContain("incident('waiting'");
    expect(helperSource).not.toContain("incident('generating'");
  });

  it('does not introduce the deferred direct-CDP fallback/watchdog subsystem', () => {
    expect(helperSource).not.toMatch(/browser-gpt-inspect|15\s*minute|10\s*minute|watchdog/i);
  });
});
