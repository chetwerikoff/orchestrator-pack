// Product page selectors — single drift surface for ChatGPT UI markers.
// Re-exported from ui-adapter.ts for transport callers; tests/fixtures import here
// directly to avoid vi.mock cycles on the full ui-adapter module.

export const COMPOSER_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
export const SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"][aria-label="Send"]';
export const MESSAGE_AUTHOR_ROLE_ATTR = 'data-markdown-text-style';
export const MESSAGE_ID_ATTR = 'data-chatgpt-selection-message-id';
// Live user messages carry no selection id or markdown style; their search unit
// (`<turn>:<n>:user`) is the only stable per-message user node and id carrier.
export const MESSAGE_UNIT_KEY_ATTR = 'data-chatgpt-search-unit-key';
export const MESSAGE_UNIT_IDS_ATTR = 'data-chatgpt-search-message-ids';
export const USER_MESSAGE_UNIT_SELECTOR = `[${MESSAGE_UNIT_KEY_ATTR}$=":user"]`;
const SELECTION_MESSAGE_NODE_SELECTOR = `[${MESSAGE_ID_ATTR}]:not(${USER_MESSAGE_UNIT_SELECTOR} *)`;
export const MESSAGE_NODE_SELECTOR = `${USER_MESSAGE_UNIT_SELECTOR}, ${SELECTION_MESSAGE_NODE_SELECTOR}`;
export const USER_MESSAGE_STYLE = 'user-message';
export const ASSISTANT_MESSAGE_STYLE = 'assistant-message';
export const USER_MESSAGE_SELECTOR = `${USER_MESSAGE_UNIT_SELECTOR}, ${SELECTION_MESSAGE_NODE_SELECTOR}:has([${MESSAGE_AUTHOR_ROLE_ATTR}="${USER_MESSAGE_STYLE}"])`;
export const ASSISTANT_MESSAGE_SELECTOR = `${SELECTION_MESSAGE_NODE_SELECTOR}:has([${MESSAGE_AUTHOR_ROLE_ATTR}="${ASSISTANT_MESSAGE_STYLE}"])`;
export const TURN_START_MESSAGE_ATTR = 'data-turn-key';
export const STOP_BUTTON_TESTID = 'stop-button';
export const STOP_BUTTON_SELECTOR = `[data-testid="${STOP_BUTTON_TESTID}"], button[aria-label*="Stop"]`;
export const REGENERATE_THREAD_ERROR_BUTTON_TESTID = 'regenerate-thread-error-button';
export const REGENERATE_THREAD_ERROR_BUTTON_SELECTOR = `[data-testid="${REGENERATE_THREAD_ERROR_BUTTON_TESTID}"]`;
export const CONTINUE_GENERATING_BUTTON_NAME = /continue generating/i;
export const CONTINUE_GENERATING_TESTID_SELECTOR = '[data-testid*="continue-generating"], [data-testid*="continue_generating"]';
export const CONVERSATION_TURN_SECTION_SELECTOR = 'div[data-turn-key]';
// After a new-chat URL redirect ChatGPT can keep the previous thread mounted as
// a zero-size copy frozen mid-generation, with its own Stop control and turn
// sections. Only rendered elements describe the live conversation.
export const RENDERED_STOP_BUTTON_SELECTOR = STOP_BUTTON_SELECTOR.split(', ').map((part) => `${part}:visible`).join(', ');
export const RENDERED_CONVERSATION_TURN_SECTION_SELECTOR = `${CONVERSATION_TURN_SECTION_SELECTOR}:visible`;
export const ASSISTANT_TURN_ANCESTOR_XPATH = 'xpath=ancestor-or-self::div[@data-turn-key][1]';
export const CONVERSATION_TURN_ID_PREFIX = 'conversation-turn-';

export function normalizeMessageRoleStyle(value: string | null | undefined): 'user' | 'assistant' | undefined {
  if (value === USER_MESSAGE_STYLE) return 'user';
  if (value === ASSISTANT_MESSAGE_STYLE) return 'assistant';
  return undefined;
}

/** Role style of a message node: its markdown style, else a user search-unit key. */
export function resolveMessageRoleStyle(
  style: string | null | undefined,
  unitKey: string | null | undefined,
): string | undefined {
  if (style === USER_MESSAGE_STYLE || style === ASSISTANT_MESSAGE_STYLE) return style;
  return typeof unitKey === 'string' && unitKey.endsWith(':user') ? USER_MESSAGE_STYLE : undefined;
}

export const ASSISTANT_TURN_ACTION_SELECTOR = [
  '[data-testid="copy-turn-action-button"]',
  '[data-testid="good-response-turn-action-button"]',
  '[data-testid="bad-response-turn-action-button"]',
  'button[aria-label="Copy"]',
  'button[aria-label="Rate response"]',
].join(', ');

export const ASSISTANT_TURN_IN_PROGRESS_SELECTOR = [
  '[aria-busy="true"]',
  '[data-is-streaming="true"]',
  '[data-testid*="tool"][aria-busy="true"]',
  '[data-testid*="tool"][data-state="running"]',
  '[data-testid*="tool"][data-state="loading"]',
].join(', ');

export const PRODUCT_STATUS_PROBE_SELECTORS = [
  '[role="alert"]',
  '[role="dialog"]',
  '[data-testid*="quota"]',
  '[data-testid*="limit"]',
  '[data-testid*="challenge"]',
  '[data-testid*="login"]',
  '[data-testid*="auth"]',
  '[data-testid*="error"]',
  'a[href*="/auth/login"]',
  'a[href*="/auth/signup"]',
] as const;

export const NEW_CHAT_CONTROL_SELECTORS = [
  '[data-testid="create-new-chat-button"]',
  'a:has-text("New chat")',
  'button:has-text("New chat")',
  '[aria-label="New chat"]',
] as const;

export const UI_COLLAPSE_AFFIX_RE = /(?:\s*(?:show more|read more|see more|view more|continue reading)\s*)+$/iu;
const UI_COLLAPSE_ELLIPSIS_SUFFIX_RE = /[.…]+\s*$/u;

export function stripUiCollapseAffixes(value: string): string {
  let result = value;
  for (let pass = 0; pass < 3; pass++) {
    const next = result
      .replace(UI_COLLAPSE_AFFIX_RE, '')
      .replace(UI_COLLAPSE_ELLIPSIS_SUFFIX_RE, '')
      .trim();
    if (next === result) break;
    result = next;
  }
  return result;
}

export function matchesNewChatControlSelector(selector: string): boolean {
  return NEW_CHAT_CONTROL_SELECTORS.some((candidate) => candidate === selector)
    || selector.includes('create-new-chat-button')
    || selector.includes('New chat');
}

export function matchesAssistantTurnActionSelector(selector: string): boolean {
  return selector === ASSISTANT_TURN_ACTION_SELECTOR
    || selector.includes('copy-turn-action-button')
    || selector.includes('good-response-turn-action-button')
    || selector.includes('bad-response-turn-action-button');
}

export function matchesAssistantTurnInProgressSelector(selector: string): boolean {
  return selector === ASSISTANT_TURN_IN_PROGRESS_SELECTOR
    || selector.includes('[aria-busy="true"]')
    || selector.includes('[data-is-streaming="true"]')
    || selector.includes('[data-testid*="tool"]');
}

export function matchesStopButtonSelector(selector: string): boolean {
  return selector === STOP_BUTTON_SELECTOR || selector.includes(STOP_BUTTON_TESTID);
}
