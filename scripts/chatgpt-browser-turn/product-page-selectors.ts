// Product page selectors — single drift surface for ChatGPT UI markers.
// Re-exported from ui-adapter.ts for transport callers; tests/fixtures import here
// directly to avoid vi.mock cycles on the full ui-adapter module.

export const COMPOSER_SELECTOR = '#prompt-textarea';
export const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
export const MESSAGE_AUTHOR_ROLE_ATTR = 'data-message-author-role';
export const MESSAGE_IDENTITY_ATTR = 'data-message-id';
export const MESSAGE_NODE_SELECTOR = `[${MESSAGE_AUTHOR_ROLE_ATTR}]`;
export const USER_MESSAGE_SELECTOR = `[${MESSAGE_AUTHOR_ROLE_ATTR}="user"]`;
export const ASSISTANT_MESSAGE_SELECTOR = `[${MESSAGE_AUTHOR_ROLE_ATTR}="assistant"]`;
export const TURN_START_MESSAGE_ATTR = 'data-turn-start-message';
export const STOP_BUTTON_TESTID = 'stop-button';
export const STOP_BUTTON_SELECTOR = `[data-testid="${STOP_BUTTON_TESTID}"], button[aria-label*="Stop"]`;
export const CONTINUE_GENERATING_BUTTON_NAME = /continue generating/i;
export const CONTINUE_GENERATING_TESTID_SELECTOR = '[data-testid*="continue-generating"], [data-testid*="continue_generating"]';
export const CONVERSATION_TURN_SECTION_SELECTOR = 'section[data-testid^="conversation-turn-"]';
export const ASSISTANT_TURN_ANCESTOR_XPATH = 'xpath=ancestor-or-self::section[starts-with(@data-testid, "conversation-turn-")][1]';
export const CONVERSATION_TURN_ID_PREFIX = 'conversation-turn-';

export const ASSISTANT_TURN_ACTION_SELECTOR = [
  '[data-testid="copy-turn-action-button"]',
  '[data-testid="good-response-turn-action-button"]',
  '[data-testid="bad-response-turn-action-button"]',
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

function escapeCssString(value: string): string {
  let escaped = '';
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0) {
      escaped += '\\fffd ';
      continue;
    }
    if ((codePoint >= 1 && codePoint <= 31) || codePoint === 127) {
      escaped += `\\${codePoint.toString(16)} `;
      continue;
    }
    if (char === '"' || char === '\\') escaped += `\\${char}`;
    else escaped += char;
  }
  return escaped;
}

/**
 * Exact opaque message-identity lookup; never interpolate an unescaped id.
 * Regression coverage evaluates this selector through an independent CSS-string
 * decoder, including quotes, backslashes, brackets, controls, and injection-like ids.
 */
export function messageIdentitySelector(identity: string): string {
  if (!identity) throw new Error('message_identity_required');
  return `${MESSAGE_NODE_SELECTOR}[${MESSAGE_IDENTITY_ATTR}="${escapeCssString(identity)}"]`;
}

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
