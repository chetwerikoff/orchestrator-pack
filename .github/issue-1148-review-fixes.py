from pathlib import Path
from textwrap import dedent

def block(value: str) -> str:
    return dedent(value).strip("\n")

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

source_path = Path("scripts/chatgpt-browser-turn/state-light-turn.ts")
source = source_path.read_text(encoding="utf-8")

source = replace_once(
    source,
    "const OWNED_TAIL_CONFIRM_DELAY_MS = 100;\nconst OWNED_IDENTITY_STABLE_READS = 2;",
    "const OWNED_TAIL_CONFIRM_DELAY_MS = 100;\n"
    "const OWNED_TAIL_SNAPSHOT_BUDGET_MS = MAX_LOCAL_READ_WAIT_MS;\n"
    "const OWNED_IDENTITY_STABLE_READS = 2;",
    "tail snapshot budget constant",
)

source = replace_once(
    source,
    block("""
    export interface PageObservationResult {
      readonly messages: PageMessage[];
      readonly nodes: PageNodeObservation[];
      readonly nodeListReadFailed: boolean;
    """),
    block("""
    export interface PageObservationResult {
      readonly messages: PageMessage[];
      readonly nodes: PageNodeObservation[];
      /** Total rendered node count, including nodes outside a bounded tail read. */
      readonly nodeCount?: number;
      readonly nodeListReadFailed: boolean;
    """),
    "page observation node count",
)

source = replace_once(
    source,
    block("""
    function strictPostBaselineOwnedUserCount(
      messages: readonly PageMessage[],
      baselineCount: number,
      prompt: string,
    ): number {
      return messages
        .slice(Math.max(0, baselineCount))
        .filter((message) => message.role === 'user' && ownedPromptMatches(message.text, prompt))
        .length;
    }
    """),
    block("""
    function strictPostBaselineOwnedUserCount(
      messages: readonly PageMessage[],
      baselineCount: number,
      prompt: string,
    ): number {
      return messages.filter((message, index) => {
        const domIndex = message.domIndex ?? index;
        return domIndex >= Math.max(0, baselineCount)
          && message.role === 'user'
          && ownedPromptMatches(message.text, prompt);
      }).length;
    }
    """),
    "strict fallback baseline",
)

source = replace_once(
    source,
    block("""
    function lastAssistantVisibleText(
      messages: readonly PageMessage[],
      baselineCount: number,
    ): string {
      const novel = messages.slice(Math.max(0, baselineCount));
      const assistants = novel.filter((message) => message.role === 'assistant');
      return normalizeVisibleText(assistants.at(-1)?.text ?? '');
    }
    """),
    block("""
    function lastAssistantVisibleText(
      messages: readonly PageMessage[],
      baselineCount: number,
    ): string {
      const assistants = messages.filter((message, index) => {
        const domIndex = message.domIndex ?? index;
        return domIndex >= Math.max(0, baselineCount) && message.role === 'assistant';
      });
      return normalizeVisibleText(assistants.at(-1)?.text ?? '');
    }
    """),
    "diagnostic baseline",
)

source = replace_once(
    source,
    block("""
      return {
        messages,
        nodes: nodeObservations,
        ownedWindowCompletionReady,
        transcriptIncomplete,
        nodeListReadFailed: countResult.readFailed,
      };
    }


    function readableTailWitness
    """),
    block("""
      return {
        messages,
        nodes: nodeObservations,
        nodeCount: countResult.count,
        ownedWindowCompletionReady,
        transcriptIncomplete,
        nodeListReadFailed: countResult.readFailed,
      };
    }

    async function readTailAttribute(
      locator: any,
      attribute: string,
      deadline: number,
    ): Promise<string | null> {
      const budgets = [
        MESSAGE_NODE_READ_TIMEOUT_MS,
        MESSAGE_NODE_READ_RETRY_TIMEOUT_MS,
      ].slice(0, MESSAGE_NODE_READ_ATTEMPTS);
      for (const budget of budgets) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        try {
          return String(await locator.getAttribute(attribute, {
            timeout: Math.max(1, Math.min(budget, remaining)),
          }) ?? '');
        } catch {
          // Retry only while the single tail-snapshot budget remains.
        }
      }
      return null;
    }

    /**
     * Read only the minimal pre-send suffix. Continuation reads walk backward
     * and stop at the last user anchor; verified-fresh reads prove zero users.
     */
    export async function readTailPageObservation(
      page: any,
      allowFreshSentinel: boolean,
    ): Promise<PageObservationResult> {
      const nodes = page.locator(MESSAGE_NODE_SELECTOR);
      const countResult = await locatorCountResult(nodes);
      const deadline = Date.now() + OWNED_TAIL_SNAPSHOT_BUDGET_MS;
      const reverseNodes: PageNodeObservation[] = [];
      const reverseMessages: PageMessage[] = [];
      let transcriptIncomplete = countResult.readFailed;

      if (!countResult.readFailed) {
        for (let index = countResult.count - 1; index >= 0; index--) {
          const node = nodes.nth(index);
          const roleValue = await readTailAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, deadline);
          const identityValue = await readTailAttribute(node, MESSAGE_IDENTITY_ATTR, deadline);
          const role = roleValue === 'user' || roleValue === 'assistant'
            ? roleValue
            : undefined;
          const roleReadFailed = roleValue === null;
          const identityReadFailed = identityValue === null;
          const identity = identityReadFailed || identityValue === ''
            ? undefined
            : identityValue;

          reverseNodes.push({
            domIndex: index,
            ...(role ? { role } : {}),
            ...(identity ? { identity } : {}),
            text: '',
            roleReadFailed,
            identityReadFailed,
            textReadFailed: false,
          });
          if (role) {
            reverseMessages.push({
              role,
              text: '',
              ...(identity ? { identity } : {}),
              domIndex: index,
            });
          }
          if (roleReadFailed || role === undefined) {
            transcriptIncomplete = true;
            break;
          }
          if (!allowFreshSentinel && role === 'user') break;
        }
      }

      return {
        messages: reverseMessages.reverse(),
        nodes: reverseNodes.reverse(),
        nodeCount: countResult.count,
        ownedWindowCompletionReady: false,
        transcriptIncomplete,
        nodeListReadFailed: countResult.readFailed,
      };
    }


    function readableTailWitness
    """),
    "bounded tail reader",
)

source = replace_once(
    source,
    block("""
    function uniqueIdentityNodeIndex(
      nodes: readonly PageNodeObservation[],
      identity: string,
    ): number | undefined {
      const matches = nodes.filter((node) => node.identity === identity);
      if (matches.length !== 1) return undefined;
      return matches[0]!.domIndex;
    }
    """),
    block("""
    function uniqueIdentityNodeIndex(
      nodes: readonly PageNodeObservation[],
      identity: string,
    ): number | undefined {
      const matches = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => node.identity === identity);
      if (matches.length !== 1) return undefined;
      return matches[0]!.index;
    }
    """),
    "tail array index",
)

source = replace_once(
    source,
    block("""
      const matching = observation.nodes.filter((node) => node.identity === boundary.anchorIdentity);
      if (matching.length > 1) return { state: 'changed' };
      if (matching.length === 0) {
        return observation.nodes.some((node) => node.identityReadFailed)
          ? { state: 'unresolved' }
          : { state: 'changed' };
      }
      const anchor = matching[0]!;
      if (anchor.role !== 'user') return { state: 'changed' };
      const currentSuffix = observation.nodes.slice(anchor.domIndex, anchor.domIndex + boundary.suffix.length);
      if (currentSuffix.length !== boundary.suffix.length) return { state: 'changed' };
    """),
    block("""
      const matching = observation.nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => node.identity === boundary.anchorIdentity);
      if (matching.length > 1) return { state: 'changed' };
      if (matching.length === 0) {
        return observation.nodes.some((node) => node.identityReadFailed)
          ? { state: 'unresolved' }
          : { state: 'changed' };
      }
      const { node: anchor, index: anchorIndex } = matching[0]!;
      if (anchor.role !== 'user') return { state: 'changed' };
      const currentSuffix = observation.nodes.slice(
        anchorIndex,
        anchorIndex + boundary.suffix.length,
      );
      if (currentSuffix.length !== boundary.suffix.length) return { state: 'changed' };
    """),
    "post-tail anchor index",
)
source = replace_once(
    source,
    "    nodes: observation.nodes.slice(anchor.domIndex + boundary.suffix.length),",
    "    nodes: observation.nodes.slice(anchorIndex + boundary.suffix.length),",
    "post-tail slice",
)

source = replace_once(
    source,
    "    let boundMissingReads = 0;\n"
    "    let boundUserDomIndex: number | undefined;\n"
    "    let boundUnresolvedReads = 0;",
    "    let boundMissingReads = 0;\n"
    "    let boundUnresolvedReads = 0;",
    "remove stale bound index state",
)

source = replace_once(
    source,
    block("""
          const firstTail = await readPageObservation(page);
          await sleep(page, OWNED_TAIL_CONFIRM_DELAY_MS);
          const secondTail = await readPageObservation(page);
          ownedTailBoundary = establishOwnedTailBoundary(firstTail, secondTail, config.newChat);
          observationMode = ownedTailBoundary.kind === 'text_fallback' ? 'text_fallback' : 'admission';
          baselineCount = secondTail.messages.length;
    """),
    block("""
          const firstTail = await readTailPageObservation(page, config.newChat);
          await sleep(page, OWNED_TAIL_CONFIRM_DELAY_MS);
          const secondTail = await readTailPageObservation(page, config.newChat);
          ownedTailBoundary = establishOwnedTailBoundary(firstTail, secondTail, config.newChat);
          observationMode = ownedTailBoundary.kind === 'text_fallback' ? 'text_fallback' : 'admission';
          baselineCount = secondTail.nodeCount ?? secondTail.messages.length;
    """),
    "pre-send bounded tail reads",
)

source = replace_once(
    source,
    "      boundMissingReads = 0;\n"
    "      boundUserDomIndex = undefined;\n"
    "      boundUnresolvedReads = 0;",
    "      boundMissingReads = 0;\n"
    "      boundUnresolvedReads = 0;",
    "remove stale bound index reset",
)

source = replace_once(
    source,
    block("""
            if (exactBound.state === 'missing') {
              const replacementAtPriorPosition = boundUserDomIndex === undefined
                ? undefined
                : observation.nodes[boundUserDomIndex];
              if (
                replacementAtPriorPosition
                && !replacementAtPriorPosition.roleReadFailed
                && !replacementAtPriorPosition.identityReadFailed
                && (
                  replacementAtPriorPosition.role !== 'user'
                  || replacementAtPriorPosition.identity !== boundIdentity
                )
              ) {
                return returnOwnedMessageIdentityMismatch(
                  'owned_message_identity_changed', page, browser, invocationId, profileKey,
                  sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
                );
              }
              boundMissingReads += 1;
    """),
    block("""
            if (exactBound.state === 'missing') {
              // DOM indices can shift as historical nodes materialize or virtualize.
              // Zero exact matches are bounded disappearance evidence unless another
              // current-page identity/role/topology contradiction exists.
              boundMissingReads += 1;
    """),
    "stale dom-index witness",
)

source = replace_once(
    source,
    "        boundUnresolvedReads = 0;\n"
    "        boundUserDomIndex = boundWindow.boundUserDomIndex;\n"
    "        messages = [...boundWindow.messages];",
    "        boundUnresolvedReads = 0;\n"
    "        messages = [...boundWindow.messages];",
    "remove stale bound index assignment",
)

source_path.write_text(source, encoding="utf-8")

test_path = Path("scripts/chatgpt-browser-turn/state-light-page-observation.test.ts")
test = test_path.read_text(encoding="utf-8")

test = replace_once(
    test,
    "  MESSAGE_AUTHOR_ROLE_ATTR,\n"
    "  MESSAGE_NODE_SELECTOR,",
    "  MESSAGE_AUTHOR_ROLE_ATTR,\n"
    "  MESSAGE_IDENTITY_ATTR,\n"
    "  MESSAGE_NODE_SELECTOR,",
    "test identity attribute import",
)
test = replace_once(
    test,
    "  readPageObservation,\n"
    "  runStateLightTurn,",
    "  readPageObservation,\n"
    "  readTailPageObservation,\n"
    "  runStateLightTurn,",
    "tail reader test import",
)

selector_decoder = block(r"""
function decodeCssStringToken(value: string): string | undefined {
  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '"' || char === '\n' || char === '\r' || char === '\f') {
      return undefined;
    }
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    index += 1;
    if (index >= value.length) return undefined;
    const escaped = value[index]!;
    if (/[0-9a-f]/iu.test(escaped)) {
      let hex = escaped;
      while (
        hex.length < 6
        && index + 1 < value.length
        && /[0-9a-f]/iu.test(value[index + 1]!)
      ) {
        index += 1;
        hex += value[index]!;
      }
      if (index + 1 < value.length && /\s/u.test(value[index + 1]!)) index += 1;
      const codePoint = Number.parseInt(hex, 16);
      decoded += codePoint === 0 ? '\uFFFD' : String.fromCodePoint(codePoint);
      continue;
    }
    if (escaped === '\n' || escaped === '\r' || escaped === '\f') return undefined;
    decoded += escaped;
  }
  return decoded;
}

function independentlyDecodeMessageIdentitySelector(selector: string): string | undefined {
  const prefix = `[${MESSAGE_AUTHOR_ROLE_ATTR}][${MESSAGE_IDENTITY_ATTR}="`;
  if (!selector.startsWith(prefix) || !selector.endsWith('"]')) return undefined;
  return decodeCssStringToken(selector.slice(prefix.length, -2));
}

""")
test = replace_once(
    test,
    "describe('state-light owned message identity', () => {",
    selector_decoder + "\n" + "describe('state-light owned message identity', () => {",
    "independent selector decoder",
)

test = replace_once(
    test,
    block(r"""
      it('escapes opaque identity metacharacters for exact selector lookup', () => {
        expect(messageIdentitySelector('a"b\\c]')).toBe(
          '[data-message-author-role][data-message-id="a\\"b\\\\c]"]',
        );
      });
    """),
    block(r"""
      it('builds an exact opaque selector accepted by an independent selector decoder', () => {
        const identity = 'opaque"\\[]\u0001\u007f"][data-message-author-role="assistant';
        const selector = messageIdentitySelector(identity);
        expect(independentlyDecodeMessageIdentitySelector(selector)).toBe(identity);

        const malformed = `[${MESSAGE_AUTHOR_ROLE_ATTR}][${MESSAGE_IDENTITY_ATTR}="${identity}"]`;
        expect(independentlyDecodeMessageIdentitySelector(malformed)).toBeUndefined();
      });
    """),
    "selector behavior unit",
)

tail_test = block(r"""
describe('bounded pre-send tail observation', () => {
  it('reads only the last-user suffix on a long continuation with unreadable distant history', async () => {
    const messageCount = 1_202;
    const accessed: number[] = [];
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector !== MESSAGE_NODE_SELECTOR) return scalarLocator();
        return scalarLocator({
          count: vi.fn(async () => messageCount),
          nth: vi.fn((index: number) => {
            accessed.push(index);
            if (index < 1_200) throw new Error('distant history must not be read');
            return messageLocator(index === 1_200
              ? { role: 'user', text: '', identity: 'tail-user' }
              : { role: 'assistant', text: '', identity: 'tail-assistant' });
          }),
        });
      }),
    };

    const first = await readTailPageObservation(page, false);
    const second = await readTailPageObservation(page, false);

    expect(accessed).toEqual([1_201, 1_200, 1_201, 1_200]);
    expect(first.nodeCount).toBe(messageCount);
    expect(establishOwnedTailBoundary(first, second, false)).toEqual({
      kind: 'anchor',
      anchorIdentity: 'tail-user',
      suffix: [
        { role: 'user', identity: 'tail-user' },
        { role: 'assistant', identity: 'tail-assistant' },
      ],
    });
  });
});

""")
test = replace_once(
    test,
    "\n\nfunction identityObservation(",
    "\n\n" + tail_test + "\nfunction identityObservation(",
    "long continuation tail test",
)

test = replace_once(
    test,
    block("""
          const exactIdentityMatches = activeSnapshot.messages.filter(
            (message) => message.identity && messageIdentitySelector(message.identity) === selector,
          );
    """),
    block("""
          const selectedIdentity = independentlyDecodeMessageIdentitySelector(selector);
          const exactIdentityMatches = selectedIdentity === undefined
            ? []
            : activeSnapshot.messages.filter((message) => message.identity === selectedIdentity);
    """),
    "independent locator double",
)

test = replace_once(
    test,
    block(r"""
      it('publishes from the exact metacharacter identity window without prompt-text authority', async () => {
        const identity = 'owned[message]"\\#1';
        const fake = makeIdentityRuntimePage(
          preSend,
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
    """),
    block(r"""
      it('publishes only from an independently evaluated opaque exact selector', async () => {
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
      });
    """),
    "selector runtime behavior",
)

stale_prefix_test = block(r"""
  it('treats a transient exact-selector miss after prefix materialization as bounded disappearance', async () => {
    const identity = 'owned-prefix-shift';
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const materializedPrefix: StateLightTestMessage[] = [
      { role: 'user', text: 'OLDER', identity: 'older-user' },
      { role: 'assistant', text: 'OLDER ANSWER', identity: 'older-assistant' },
    ];
    const shiftedMissing: StateLightTestSnapshot = {
      messages: [...materializedPrefix, ...preSend],
      generating: false,
    };
    const shiftedReady: StateLightTestSnapshot = {
      messages: [
        ...materializedPrefix,
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'SHIFTED-FINAL', identity: 'shifted-answer', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      working,
      working,
      working,
      shiftedMissing,
      shiftedReady,
      shiftedReady,
      shiftedReady,
      shiftedReady,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');

    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.output).toBe('SHIFTED-FINAL');
    expect(outcome.result.cause).toBe('completed_page_only');
    expect(fake.metrics.reloads).toBe(0);
  });

""")
test = replace_once(
    test,
    "  it('reports bounded disappearance after binding and never initiates reload', async () => {",
    stale_prefix_test + "\n  it('reports bounded disappearance after binding and never initiates reload', async () => {",
    "stale prefix disappearance regression",
)

start = test.index("  it('isolates byte-identical prompts in distinct owned tabs by opaque identity'")
end_marker = "\n  });\n});"
end = test.index(end_marker, start) + len("\n  });")
swap_test = block(r"""
  it('uses a controlled identity-to-window swap for byte-identical prompts across pages', async () => {
    const { readFileSync, rmSync } = await import('node:fs');
    const outputA = `/tmp/issue-1148-a-${Math.random().toString(16).slice(2)}.txt`;
    const outputB = `/tmp/issue-1148-b-${Math.random().toString(16).slice(2)}.txt`;
    const swappedFrames = (
      ownedIdentity: string,
      ownedReply: string,
      decoyIdentity: string,
      decoyReply: string,
    ): StateLightTestSnapshot[] => {
      const working: StateLightTestSnapshot = {
        messages: [
          ...preSend,
          { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: ownedIdentity },
          { role: 'assistant', text: 'working', identity: `${ownedIdentity}-working` },
        ],
        generating: true,
      };
      const ownedReady: StateLightTestSnapshot = {
        messages: [
          ...preSend,
          { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: ownedIdentity },
          { role: 'assistant', text: ownedReply, identity: `${ownedIdentity}-answer`, finalAction: true },
        ],
        generating: false,
      };
      const swappedReady: StateLightTestSnapshot = {
        messages: [
          ...ownedReady.messages,
          { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: decoyIdentity },
          { role: 'assistant', text: decoyReply, identity: `${decoyIdentity}-answer`, finalAction: true },
        ],
        generating: false,
      };
      return [working, ownedReady, swappedReady, swappedReady, swappedReady, swappedReady];
    };
    const fakeA = makeIdentityRuntimePage(
      preSend,
      swappedFrames('owned-a', 'REPLY-A', 'owned-b', 'DECOY-B-ON-A'),
    );
    const fakeB = makeIdentityRuntimePage(
      preSend,
      swappedFrames('owned-b', 'REPLY-B', 'owned-a', 'DECOY-A-ON-B'),
    );
    runtimeMocks.prompt = 'BYTE-IDENTICAL-PROMPT';
    runtimeMocks.nowMs = 10_000;
    runtimeMocks.browserQueue.length = 0;
    runtimeMocks.browserQueue.push(browserFor(fakeA.page).browser, browserFor(fakeB.page).browser);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => runtimeMocks.nowMs);
    const argv = (output: string) => [
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', '/tmp/prompt.txt',
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--timeout-ms', '5000',
      '--poll-ms', '1',
    ];
    try {
      const codes = await Promise.all([
        runStateLightTurn(argv(outputA)),
        runStateLightTurn(argv(outputB)),
      ]);
      expect(codes).toEqual([0, 0]);
      expect(readFileSync(outputA, 'utf8')).toBe('REPLY-A');
      expect(readFileSync(outputB, 'utf8')).toBe('REPLY-B');
      expect(readFileSync(outputA, 'utf8')).not.toBe('DECOY-B-ON-A');
      expect(readFileSync(outputB, 'utf8')).not.toBe('DECOY-A-ON-B');
      const results = writes
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.schema === 'turn-result/v1');
      expect(results).toHaveLength(2);
      expect(results.every((row) => row.state === 'ok' && row.send_count === 1)).toBe(true);
      expect(fakeA.metrics.sends).toBe(1);
      expect(fakeB.metrics.sends).toBe(1);
    } finally {
      stdout.mockRestore();
      now.mockRestore();
      rmSync(outputA, { force: true });
      rmSync(outputB, { force: true });
    }
  });
""")
test = test[:start] + swap_test + test[end:]

test_path.write_text(test, encoding="utf-8")
