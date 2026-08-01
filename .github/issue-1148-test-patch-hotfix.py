from pathlib import Path

path = Path('.github/issue-1148-review-fixes.py')
text = path.read_text(encoding='utf-8')

# Replace the indentation/escape-sensitive selector unit replacement with
# marker-based editing of the TypeScript test file.
start = text.index(
    'test = replace_once(\n'
    '    test,\n'
    '    block(r"""\n'
    "      it('escapes opaque identity metacharacters for exact selector lookup'"
)
end = text.index('tail_test = block(r"""', start)
replacement = r'''selector_unit_start = test.index(
    "  it('escapes opaque identity metacharacters for exact selector lookup'"
)
selector_unit_end = test.index(
    "\n\n  it('establishes a stable tail anchor",
    selector_unit_start,
)
selector_unit = r'''  it('builds an exact opaque selector accepted by an independent selector decoder', () => {
    const identity = 'opaque"\\[]\u0001\u007f"][data-message-author-role="assistant';
    const selector = messageIdentitySelector(identity);
    expect(independentlyDecodeMessageIdentitySelector(selector)).toBe(identity);

    const malformed = `[${MESSAGE_AUTHOR_ROLE_ATTR}][${MESSAGE_IDENTITY_ATTR}="${identity}"]`;
    expect(independentlyDecodeMessageIdentitySelector(malformed)).toBeUndefined();
  });'''
test = test[:selector_unit_start] + selector_unit + test[selector_unit_end:]

'''
text = text[:start] + replacement + text[end:]

# Replace the circular fake-locator matcher by exact selector decoding without
# relying on the production selector builder.
start = text.index(
    'test = replace_once(\n'
    '    test,\n'
    '    block("""\n'
    '          const exactIdentityMatches = activeSnapshot.messages.filter('
)
end = text.index(
    'test = replace_once(\n'
    '    test,\n'
    '    block(r"""\n'
    "      it('publishes from the exact metacharacter identity window",
    start,
)
replacement = r'''locator_match_start = test.index(
    "      const exactIdentityMatches = activeSnapshot.messages.filter("
)
locator_match_end = test.index(
    "      if (exactIdentityMatches.length > 0) {",
    locator_match_start,
)
test = test[:locator_match_start] + (
    "      const selectedIdentity = independentlyDecodeMessageIdentitySelector(selector);\n"
    "      const exactIdentityMatches = selectedIdentity === undefined\n"
    "        ? []\n"
    "        : activeSnapshot.messages.filter((message) => message.identity === selectedIdentity);\n"
) + test[locator_match_end:]

'''
text = text[:start] + replacement + text[end:]

# Replace the old runtime selector regression with independent-decoder success
# and duplicate fail-closed cases.
start = text.index(
    'test = replace_once(\n'
    '    test,\n'
    '    block(r"""\n'
    "      it('publishes from the exact metacharacter identity window"
)
end = text.index('stale_prefix_test = block(r"""', start)
replacement = r'''selector_runtime_start = test.index(
    "  it('publishes from the exact metacharacter identity window without prompt-text authority'"
)
selector_runtime_end = test.index(
    "\n\n  it('does not inherit completion from historical turns before the exact bound reply is complete'",
    selector_runtime_start,
)
selector_runtime_tests = r'''  it('publishes only from an independently evaluated opaque exact selector', async () => {
    const identity = 'owned"\\[]\u0001\u007f"][data-message-author-role="assistant';
    const selectorPreSend: StateLightTestMessage[] = [
      { role: 'user', text: 'DECOY', identity: `${identity}-prefix` },
      { role: 'assistant', text: 'DECOY ANSWER', identity: `${identity}-assistant` },
      ...preSend,
    ];
    const fake = makeIdentityRuntimePage(
      selectorPreSend,
      identityRuntimeFrames(identity, 'FINAL-IDENTITY', {
        renderedPrompt: 'Rendered markdown and Unicode spacing are intentionally different',
      }),
    );
    const outcome = await runIdentityRuntimeTurn(fake.page, '# PROMPT\n\n*canonical body*');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBe('FINAL-IDENTITY');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(fake.metrics.reloads).toBe(0);
  });

  it('fails closed when an opaque exact selector becomes duplicate after binding', async () => {
    const identity = 'duplicate"\\[]\u0001\u007f"][data-message-id="other';
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const duplicate: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'NOT-PUBLISHED', identity: 'answer', finalAction: true },
        { role: 'user', text: 'PROMPT', identity },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [working, working, working, duplicate]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
  });'''
test = test[:selector_runtime_start] + selector_runtime_tests + test[selector_runtime_end:]

'''
text = text[:start] + replacement + text[end:]

path.write_text(text, encoding='utf-8')
