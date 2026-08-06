from pathlib import Path
import subprocess

REPO = 'chetwerikoff/orchestrator-pack'


def replace_once(body: str, old: str, new: str) -> str:
    count = body.count(old)
    if count != 1:
        raise SystemExit(f'Issue body anchor count {count}, expected 1: {old[:120]!r}')
    return body.replace(old, new, 1)


body = subprocess.check_output([
    'gh', 'issue', 'view', '1283', '--repo', REPO,
    '--json', 'body', '--jq', '.body',
], text=True)

body = replace_once(body, '<!-- source-revision: r06 -->', '''<!-- source-revision: r07 -->

## r07 post-review amendment

The consolidated T3 architectural review on PR #1371 at head `b4fd347a56dd431a201d78e99b5720acd70bc316` is adopted as binding correction authority. It narrows, rather than transfers, manager responsibility:

- `child_stdout_eof_timeout` is the sole launcher-side exception to the r06 helper-only boundary. Before terminating the child, `scripts/flow-manager-long-running-child.ts` must consume one process-local stdout cancellation receipt bound to the invocation id, configured profile key, normalized ChatGPT conversation URL, exact owned marker, and `send_count: 1`; reacquire only that exact owned conversation; attempt and record Stop once; emit a truthful terminal envelope; and only then abort the child.
- The EOF handshake never harvests an answer, sends or resends a prompt, navigates a conversation, creates a successor, or closes a tab. Tab close remains Issue #1266.
- Stop authority is distinct from observation and cleanup authority. Only the exact still-held initial page or invocation-created successor may receive Stop; a marker-reacquired/sibling/foreign page never inherits Stop or close authority.
- Fresh-chat recovery that discovers the conversation before the original URL claim must atomically claim that recovered URL for the same invocation before observation resumes and must fail closed on contention.
- Deterministic tests stay in existing classified suites. They cover production `runStateLightTurn` loss/exhaustion paths and the long-running-child EOF handshake, asserting one send, exact ownership, truthful terminal output, and no foreign Stop or close.

All r06 requirements remain binding except where the exact receipt/launcher prohibitions below conflict with this amendment.''')

body = replace_once(
    body,
    'No new manager state, transition, receipt, queue, probe authority, caller-side browser recovery implementation, or persisted non-complete result mapper is permitted.',
    'No new manager state, transition, queue, probe authority, caller-side answer recovery implementation, or persisted non-complete result mapper is permitted. The only manager-side exception is the r07 receipt-bound one-shot cancellation handshake: it may consume the process-local stdout receipt, reacquire only the invocation-owned conversation, attempt and record Stop once, publish an honest terminal envelope, and then terminate the child; it never harvests an answer, resends, navigates, creates a successor, or closes a tab.',
)

body = replace_once(
    body,
    '- Existing tests under `scripts/chatgpt-browser-turn/**` plus `scripts/toolchain/chatgpt-browser-turn.test.ts` and `scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts` as needed.\n- `.claude/skills/create-issue-draft/SKILL.md` — only the narrow successor/no-resend/cleanup and envelope-witness alignment.',
    '- Existing tests under `scripts/chatgpt-browser-turn/**` plus `scripts/toolchain/chatgpt-browser-turn.test.ts` and `scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts` as needed.\n- `scripts/flow-manager-long-running-child.ts` — only the receipt-bound `child_stdout_eof_timeout` cancellation handshake and truthful terminal envelope required by r07.\n- `scripts/flow-manager-long-running-child.test.ts` — deterministic EOF cancellation coverage; no close and no resend.\n- `.claude/skills/create-issue-draft/SKILL.md` — only the narrow successor/no-resend/cleanup and envelope-witness alignment.',
)

body = replace_once(
    body,
    '- New result/capture/receipt/journal/smoke schemas, CLI operations/options, environment contracts, package scripts, dependencies, generated artifacts, persistent traces, or side artifacts.',
    '- New terminal result/capture/journal/smoke schemas, CLI operations/options, environment contracts, package scripts, dependencies, generated artifacts, persistent traces, or side artifacts. The sole schema exception is the process-local stdout cancellation receipt used only by the EOF handshake; it is not persisted and grants no capture, resend, navigation, successor, or close authority.',
)

body = replace_once(
    body,
    '17. **Existing result contract.** Success/failure use `turn-result/v1`; no new state/scope/incident/retry enum, `error` field, schema, capture, receipt, CLI option, environment contract, manager artifact, persisted stage-evidence binding, or caller-classifier producer is introduced. Only the four named new cause strings may be added.',
    '17. **Existing result contract.** Success/failure use `turn-result/v1`; no new state/scope/incident/retry enum, `error` field, terminal result/capture schema, CLI option, environment contract, persisted stage-evidence binding, or caller-classifier producer is introduced. The only added schema is the ephemeral stdout cancellation receipt bound to `send_count: 1` for the r07 EOF handshake; it is not a terminal result or persistent artifact. Only the four r06 recovery cause strings plus the bounded EOF cancellation causes may be added.',
)

body = replace_once(
    body,
    '18. **Manager/caller authority unchanged.** Caller skill gains only §6 alignment. Flow-manager/probe gain no capture, publication, navigation, retry, resend, cleanup, actuation, or progression authority.',
    '18. **Manager/caller authority remains closed.** Caller skill gains only §6 alignment. Probe gains no authority. Flow-manager gains only the r07 EOF cancellation authority: validate the receipt, reacquire the exact owned target, attempt Stop once, record the truthful terminal envelope, and terminate the child. It gains no answer capture/publication, navigation, retry, resend, successor creation, cleanup/close, or progression authority.',
)

body = replace_once(
    body,
    '20. **Focused implementation and test-output decision.** No new service, framework, dependency, command, test file, schema, persistent mechanism, or side artifact is added; existing tests are modified; current `light` classifications and fixed downstream output files remain unchanged.',
    '20. **Focused implementation and test-output decision.** No new service, framework, dependency, command, test file, persistent mechanism, or side artifact is added; existing classified tests are modified; current `light` classifications and fixed downstream output files remain unchanged. The sole added schema is the non-persistent r07 stdout cancellation receipt.',
)

body = replace_once(
    body,
    '''```allowed-roots
scripts/chatgpt-browser-turn/**
scripts/toolchain/chatgpt-browser-turn.test.ts
scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts
.claude/skills/create-issue-draft/SKILL.md
.cursor/rules/flow-manager-browser-turn-monitoring.mdc
docs/declarations/**
```''',
    '''```allowed-roots
scripts/chatgpt-browser-turn/**
scripts/flow-manager-long-running-child.ts
scripts/flow-manager-long-running-child.test.ts
scripts/toolchain/chatgpt-browser-turn.test.ts
scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts
.claude/skills/create-issue-draft/SKILL.md
.cursor/rules/flow-manager-browser-turn-monitoring.mdc
docs/declarations/**
```''',
)

issue_body_path = Path('/tmp/issue-1283-r07.md')
issue_body_path.write_text(body)
subprocess.run([
    'gh', 'issue', 'edit', '1283', '--repo', REPO,
    '--body-file', str(issue_body_path),
], check=True)

test_path = Path('scripts/chatgpt-browser-turn/tab-lifecycle.test.ts')
test_text = test_path.read_text()
import_anchor = "import { loadChromium } from './ui-adapter.ts';\n"
import_block = """import {
  buildBrowserTurnCancellationReceipt,
  cancelOwnedGenerationFromReceipt,
  isSupportedChatGptConversationUrl,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';
"""
if import_block not in test_text:
    if test_text.count(import_anchor) != 1:
        raise SystemExit('tab-lifecycle import anchor mismatch')
    test_text = test_text.replace(import_anchor, import_anchor + import_block, 1)

tests = r'''

describe('Issue #1283 receipt-bound cancellation primitive', () => {
  const marker = `OPKTURNV1${'12'.repeat(16)}`;
  const ownedUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  const foreignUrl = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';

  it('accepts only closed ChatGPT conversation origins and UUID paths', () => {
    expect(isSupportedChatGptConversationUrl(ownedUrl)).toBe(true);
    expect(isSupportedChatGptConversationUrl(`${ownedUrl}?model=auto#x`)).toBe(true);
    expect(isSupportedChatGptConversationUrl('https://evil.example/c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/not-c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/c/not-a-uuid')).toBe(false);
  });

  it('treats a missing Stop control as unconfirmed rather than completed', async () => {
    const page = {
      isClosed: () => false,
      locator: () => ({ count: vi.fn(async () => 0) }),
    };
    await expect(stopOwnedGeneration(page)).resolves.toBe('unconfirmed');
  });

  it('Stops exactly one receipt-proven owned page and never closes a sibling', async () => {
    const owned = { url: () => ownedUrl, close: vi.fn() };
    const sibling = { url: () => foreignUrl, close: vi.fn() };
    const stop = vi.fn(async () => 'confirmed' as const);
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const result = await cancelOwnedGenerationFromReceipt(receipt!, 'http://127.0.0.1:9222', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [sibling, owned]),
      readUserMessages: vi.fn(async (page) => ({
        messages: page === owned
          ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
          : [{ role: 'user' as const, text: 'foreign prompt' }],
        incomplete: false,
      })),
      stop,
    });
    expect(result).toMatchObject({
      state: 'no_reply',
      cause: 'child_stdout_eof_timeout_generation_stopped',
      sendCount: 1,
      stopOutcome: 'confirmed',
      identityProven: true,
      conversationUrl: ownedUrl,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(owned);
    expect(owned.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
  });
});
'''
if "describe('Issue #1283 receipt-bound cancellation primitive'" not in test_text:
    test_text += tests
test_path.write_text(test_text)
Path('scripts/chatgpt-browser-turn/state-light-cancellation.test.ts').unlink()
