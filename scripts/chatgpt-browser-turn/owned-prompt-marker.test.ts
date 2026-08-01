import { describe, expect, it, vi } from 'vitest';

import {
  extractOwnedPromptMarkerToken,
  generateOwnedPromptMarker,
  isOwnedPromptMarker,
  ownedPromptMarkerMatches,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';

const marker = 'OPKTURNV1' + '0123456789abcdef0123456789abcdef';

describe('owned prompt marker contract', () => {
  it('generates one valid marker from exactly one source call', () => {
    const source = vi.fn(() => Uint8Array.from({ length: 16 }, (_, index) => index));

    expect(generateOwnedPromptMarker(source)).toBe(
      'OPKTURNV1000102030405060708090a0b0c0d0e0f',
    );
    expect(source).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledWith(16);
  });

  it('keeps byte-identical payload generations independent', () => {
    const source = vi.fn()
      .mockReturnValueOnce(Uint8Array.from({ length: 16 }, () => 0x11))
      .mockReturnValueOnce(Uint8Array.from({ length: 16 }, () => 0x22));

    const first = generateOwnedPromptMarker(source);
    const second = generateOwnedPromptMarker(source);

    expect(first).not.toBe(second);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('wraps the marker without rewriting the original payload', () => {
    const payload = '# table\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(wrapOwnedPromptPayload(marker, payload)).toBe(`${marker}\n\n${payload}`);
  });

  it.each([
    ['plain', marker],
    ['unicode whitespace', `\u00a0\u1680${marker}`],
    ['alternating prefix one', ` \uFEFF\u200B\t${marker}`],
    ['alternating prefix two', `\u200B\uFEFF \u200B${marker}`],
    ['line endings', `\r\n${marker}\nbody`],
  ])('extracts the closed head token: %s', (_name, text) => {
    expect(extractOwnedPromptMarkerToken(text)).toBe(marker);
    expect(ownedPromptMarkerMatches(text, marker)).toBe(true);
  });

  it.each([
    `.${marker}`,
    `**${marker}**`,
    `You said: ${marker}`,
    `OPKTURNV1${'0123456789abcdef0123456789abcde'}`,
    `opkturnv1${'0123456789abcdef0123456789abcdef'}`,
    `prefix ${marker}`,
  ])('rejects a non-exact marker head: %s', (text) => {
    expect(ownedPromptMarkerMatches(text, marker)).toBe(false);
  });

  it('stops the token at the next consumable scalar', () => {
    expect(extractOwnedPromptMarkerToken(`${marker}\uFEFFbody`)).toBe(marker);
    expect(extractOwnedPromptMarkerToken(`${marker}\u200Bbody`)).toBe(marker);
    expect(extractOwnedPromptMarkerToken(`${marker} body`)).toBe(marker);
  });

  it('validates only the fixed version-1 grammar', () => {
    expect(isOwnedPromptMarker(marker)).toBe(true);
    expect(isOwnedPromptMarker('OPKTURNV2' + '0'.repeat(32))).toBe(false);
    expect(isOwnedPromptMarker(`${marker}!`)).toBe(false);
  });
});
