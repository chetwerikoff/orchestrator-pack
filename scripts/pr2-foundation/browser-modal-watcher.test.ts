import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODAL_PROBE_EXPRESSION, ModalWatcher } from './browser-modal-watcher.ts';

type FakeElement = {
  readonly innerText: string;
  readonly buttons: readonly FakeElement[];
  clicked: boolean;
  querySelectorAll(selector: string): readonly FakeElement[];
  click(): void;
};

function element(innerText: string, buttons: readonly FakeElement[] = []): FakeElement {
  const value: FakeElement = {
    innerText,
    buttons,
    clicked: false,
    querySelectorAll: (selector) => selector === 'button' ? value.buttons : [],
    click: () => {
      value.clicked = true;
    },
  };
  return value;
}

function evaluate(nodes: readonly FakeElement[]): string {
  const document = { querySelectorAll: () => nodes };
  return runInNewContext(MODAL_PROBE_EXPRESSION, { document }) as string;
}

describe('ChatGPT rate-limit modal detector', () => {
  it('clicks a matching plain div even when it has no dialog role', () => {
    const button = element('Got it');
    const modal = element('Making requests too quickly', [button]);

    expect(evaluate([modal])).toContain('"clicked":true');
    expect(button.clicked).toBe(true);
  });

  it('accepts the exact OK button text and rejects unrelated buttons', () => {
    const wrong = element('Okay, thanks');
    const modal = element('Too many requests', [wrong]);

    expect(evaluate([modal])).toBe('');
    expect(wrong.clicked).toBe(false);
  });

  it('ignores long matching containers', () => {
    const button = element('OK');
    const modal = element(`temporarily limited ${'x'.repeat(600)}`, [button]);

    expect(evaluate([modal])).toBe('');
    expect(button.clicked).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('modal watcher refresh lifecycle', () => {
  it('never overlaps a slow refresh and schedules the next only after settlement', async () => {
    vi.useFakeTimers();
    const pending: Array<(value: Response) => void> = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const fetchStub = vi.fn(() => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        pending.push((value) => {
          inFlight -= 1;
          resolve(value);
        });
      });
    });
    vi.stubGlobal('fetch', fetchStub);
    const watcher = new ModalWatcher('http://127.0.0.1:9222');
    try {
      watcher.start();
      watcher.start();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(peakInFlight).toBe(1);
      pending.shift()!({ ok: true, json: async () => [] } as Response);
      await vi.advanceTimersByTimeAsync(699);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(peakInFlight).toBe(1);
    } finally {
      await watcher.stop();
      pending.shift()?.({ ok: true, json: async () => [] } as Response);
      await vi.advanceTimersByTimeAsync(2_100);
    }
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not attach a tab after stop while the CDP request is in flight', async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchStub = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchStub);
    let socketCount = 0;
    class FakeSocket {
      constructor(_url: string) { socketCount += 1; }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    const watcher = new ModalWatcher(
      'http://127.0.0.1:9222',
      FakeSocket,
    );
    watcher.start();
    await watcher.stop();
    resolveFetch!({ ok: true, json: async () => [{
      id: 'foreign-tab', type: 'page', url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/foreign-tab',
    }] } as Response);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(socketCount).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('reschedules after a rejected refresh without a parallel attempt', async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic_rejection'))
      .mockResolvedValue({ ok: true, json: async () => [] } as Response);
    vi.stubGlobal('fetch', fetchStub);
    const watcher = new ModalWatcher();
    watcher.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
