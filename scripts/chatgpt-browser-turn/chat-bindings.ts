import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Routing data only: which worktree launched turns in which ChatGPT chat. It
// carries no send, retry, or completion authority.
export interface ChatBinding {
  readonly schema: 'chat-binding/v1';
  readonly conversation_url: string;
  readonly worktree: string;
  readonly updated_at: string;
}

const CONVERSATION_ID_RE = /^https:\/\/chatgpt\.com\/(?:[^?#]*\/)?c\/([0-9a-f][0-9a-f-]{7,})(?:[/?#]|$)/i;

// Read by the fleet-wake service; agents may run with an isolated
// XDG_STATE_HOME, so the root follows HOME only.
export function chatBindingsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  return join(home, '.local', 'state', 'orchestrator-fleet', 'chat-bindings');
}

export function conversationIdFromUrl(url: string): string | undefined {
  return CONVERSATION_ID_RE.exec(url)?.[1]?.toLowerCase();
}

export function writeChatBinding(
  conversationUrl: string,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const id = conversationIdFromUrl(conversationUrl);
  if (!id) return;
  const root = chatBindingsRoot(env);
  mkdirSync(root, { recursive: true });
  const binding: ChatBinding = {
    schema: 'chat-binding/v1',
    conversation_url: conversationUrl.split(/[?#]/)[0]!,
    worktree: resolve(worktree),
    updated_at: new Date().toISOString(),
  };
  const target = join(root, `${id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(binding)}\n`, 'utf8');
  renameSync(temporary, target);
}

export function readChatBinding(
  conversationUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ChatBinding | undefined {
  const id = conversationIdFromUrl(conversationUrl);
  if (!id) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(chatBindingsRoot(env), `${id}.json`), 'utf8')) as Partial<ChatBinding>;
    return parsed.schema === 'chat-binding/v1'
      && typeof parsed.conversation_url === 'string'
      && typeof parsed.worktree === 'string'
      && typeof parsed.updated_at === 'string'
      ? parsed as ChatBinding
      : undefined;
  } catch {
    return undefined;
  }
}
