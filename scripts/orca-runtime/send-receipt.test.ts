// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';
import { classifyPromptSendReceipt, promptSendArgv, PROMPT_SEND_WAIT_SECONDS } from './send-receipt.ts';

// Recorded from Orca 1.4.251, 2026-11-07, in this worker's disposable Claude
// terminal. The prompt requested one literal response and no tools/file changes.
// The terminal was closed immediately after recording this receipt.
const recorded = {
  id: 'eb08d4d4-cfce-40b7-a076-d3d42d03dfab', ok: true,
  result: {
    send: {
      handle: 'term_ec05dae1-002e-4a10-95ae-ff9e0cad016b', accepted: true, bytesWritten: 85,
      prompt: {
        requestId: '53bdb60d-d8e9-43e7-8ef0-1c358be7593b', stages: ['input_accepted', 'turn_started'],
        provider: 'claude', observation: 'supported', processIncarnation: '36b6321e-e308-40f6-9ab3-a44ac8950bf4',
        generation: 354, baselineWorkingSequence: 0, baselineExplicitWorkingStartedAt: null, baselinePermissionSequence: 0,
      },
    },
    mutation: { requestId: '53bdb60d-d8e9-43e7-8ef0-1c358be7593b', replayed: false },
  },
  _meta: { runtimeId: 'f210dbc4-a4a2-46b8-88bf-471da69261cc' },
};

describe('native prompt receipt', () => {
  const handle = recorded.result.send.handle;
  it('confirms the recorded turn-started receipt and builds one bounded observing send', () => {
    expect(classifyPromptSendReceipt(recorded, handle)).toEqual({ status: 'turn_started' });
    expect(promptSendArgv(handle, 'wake')).toEqual([
      'terminal', 'send', '--terminal', handle, '--text', 'wake', '--enter', '--json',
      '--wait-submit', String(PROMPT_SEND_WAIT_SECONDS),
    ]);
    expect(PROMPT_SEND_WAIT_SECONDS).toBeGreaterThan(0);
    expect(PROMPT_SEND_WAIT_SECONDS).toBeLessThanOrEqual(10);
  });

  it.each([
    ['accepted-only', (r: typeof recorded) => { r.result.send.prompt.stages = ['input_accepted']; }],
    ['queued', (r: typeof recorded) => { r.result.send.prompt.stages = ['input_accepted', 'queued']; }],
    ['timed-out', (r: typeof recorded) => { r.result.send.prompt.observation = 'timeout'; }],
    ['old-host', (r: typeof recorded) => { r.result.send.prompt.provider = 'old-host'; }],
    ['unsupported', (r: typeof recorded) => { r.result.send.prompt.observation = 'unsupported'; }],
    ['wrong handle', (r: typeof recorded) => { r.result.send.handle = 'another-pane'; }],
    ['not accepted', (r: typeof recorded) => { r.result.send.accepted = false; }],
    ['contradictory request', (r: typeof recorded) => { r.result.mutation.requestId = 'different-request'; }],
    ['missing incarnation', (r: typeof recorded) => { r.result.send.prompt.processIncarnation = ''; }],
    ['failed', (r: typeof recorded) => { r.ok = false; }],
    ['reversed stages', (r: typeof recorded) => { r.result.send.prompt.stages.reverse(); }],
    ['contradictory stage', (r: typeof recorded) => { r.result.send.prompt.stages.push('queued'); }],
  ])('keeps %s unverified even if other fields look successful', (_name, change) => {
    const receipt = structuredClone(recorded);
    change(receipt);
    expect(classifyPromptSendReceipt(receipt, handle).status).toBe('unverified');
  });

  it.each([null, [], 'not-json', {}, { ok: true }, { ok: true, result: { send: { accepted: true } } }])(
    'does not promote malformed or legacy output %j', (receipt) => {
      expect(classifyPromptSendReceipt(receipt, handle).status).toBe('unverified');
    },
  );
});
