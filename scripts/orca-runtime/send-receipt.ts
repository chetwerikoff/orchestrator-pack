/** One native observation of the same accepted prompt; never a retry. */
export const PROMPT_SEND_WAIT_SECONDS = 5;

export function promptSendArgv(handle: string, text: string): string[] {
  return ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json',
    '--wait-submit', String(PROMPT_SEND_WAIT_SECONDS)];
}

export type PromptSendReceipt =
  | { readonly status: 'turn_started' }
  | { readonly status: 'unverified'; readonly reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Orca's additive input_accepted -> turn_started stages are the submit witness. */
export function classifyPromptSendReceipt(value: unknown, handle: string, incarnation: string | undefined): PromptSendReceipt {
  const unverified = (reason: string): PromptSendReceipt => ({ status: 'unverified', reason });
  const envelope = record(value);
  if (envelope?.ok !== true) return unverified('native_send_failed');
  const result = record(envelope.result);
  const send = record(result?.send);
  if (send?.handle !== handle || send.accepted !== true) return unverified('send_acceptance_unverified');
  const prompt = record(send.prompt);
  if (prompt?.provider === 'old-host') return unverified('old_host');
  if (prompt?.observation !== 'supported' || typeof prompt.provider !== 'string'
    || !prompt.provider || prompt.provider === 'unsupported') return unverified('submission_observation_unavailable');
  const mutation = record(result?.mutation);
  if (typeof prompt.requestId !== 'string' || !prompt.requestId.trim()
    || mutation?.requestId !== prompt.requestId
    || typeof prompt.processIncarnation !== 'string' || !prompt.processIncarnation.trim()) {
    return unverified('send_identity_unverified');
  }
  // Native terminal.incarnationId and prompt.processIncarnation identify the
  // same process. A matching handle alone cannot credential a replacement.
  if (!incarnation?.trim() || prompt.processIncarnation !== incarnation) {
    return unverified('recipient_incarnation_unverified');
  }
  const stages = prompt.stages;
  if (!Array.isArray(stages) || stages.length !== 2
    || stages[0] !== 'input_accepted' || stages[1] !== 'turn_started') {
    return unverified('turn_start_unverified');
  }
  return { status: 'turn_started' };
}
