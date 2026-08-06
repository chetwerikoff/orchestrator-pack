from pathlib import Path
import subprocess

REPO = 'chetwerikoff/orchestrator-pack'

body = subprocess.check_output([
    'gh', 'issue', 'view', '1283', '--repo', REPO,
    '--json', 'body', '--jq', '.body',
], text=True)

required_issue_fragments = [
    '<!-- source-revision: r07 -->',
    '## r07 post-review amendment',
    'scripts/flow-manager-long-running-child.ts',
    'scripts/flow-manager-long-running-child.test.ts',
    'receipt-bound one-shot cancellation handshake',
    'never harvests an answer, resends, navigates, creates a successor, or closes a tab',
]
for fragment in required_issue_fragments:
    if fragment not in body:
        raise SystemExit(f'Issue #1283 r07 invariant missing: {fragment!r}')

issue_body_path = Path('/tmp/issue-1283-r07.md')
issue_body_path.write_text(body)

# The canonical scope producer imports workspace packages; install exactly from
# the frozen lockfile before the workflow invokes it.
subprocess.run(['npm', 'ci', '--include=dev'], check=True)

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

standalone_test = Path('scripts/chatgpt-browser-turn/state-light-cancellation.test.ts')
if standalone_test.exists():
    standalone_test.unlink()
