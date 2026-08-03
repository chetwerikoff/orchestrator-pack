import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDriverDiagnostic } from './diagnostics.ts';
import { captureTooManyRequestsSourceWithWait } from './too-many-requests-capture.ts';

class ElementNode {
  parentElement: ElementNode | null = null;
  readonly children: ElementNode[] = [];
  readonly tagName: string;
  readonly attributes: Record<string, string | null>;
  readonly accessibleRole: string | undefined;
  readonly accessibleName: string | undefined;
  readonly visible: boolean;
  readonly enabled: boolean;

  constructor(
    tagName: string,
    attributes: Record<string, string | null> = {},
    accessibleRole?: string,
    accessibleName?: string,
    visible = true,
    enabled = true,
  ) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.accessibleRole = accessibleRole;
    this.accessibleName = accessibleName;
    this.visible = visible;
    this.enabled = enabled;
  }

  append(child: ElementNode): this {
    child.parentElement = this;
    this.children.push(child);
    return this;
  }
}

class Locator {
  private readonly readElements: () => ElementNode[];
  private readonly waitHook: ((options: { state: string; timeout: number }) => Promise<void>) | undefined;

  constructor(
    readElements: () => ElementNode[],
    waitHook?: (options: { state: string; timeout: number }) => Promise<void>,
  ) {
    this.readElements = readElements;
    this.waitHook = waitHook;
  }

  async count(): Promise<number> {
    return this.readElements().length;
  }

  nth(index: number): Locator {
    return new Locator(() => {
      const element = this.readElements()[index];
      return element ? [element] : [];
    });
  }

  async isVisible(): Promise<boolean> {
    return this.readElements()[0]?.visible ?? false;
  }

  async isEnabled(): Promise<boolean> {
    return this.readElements()[0]?.enabled ?? false;
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.readElements()[0]?.attributes[name] ?? null;
  }

  async elementHandle(): Promise<ElementNode | null> {
    return this.readElements()[0] ?? null;
  }

  async evaluate<T, A>(callback: (element: Element, arg: A) => T, arg?: A): Promise<T> {
    const element = this.readElements()[0];
    if (!element) throw new Error('missing_element');
    return callback(element as unknown as Element, arg as A);
  }

  getByRole(role: string, options: { name: string; exact: boolean }): Locator {
    return new Locator(() => {
      const root = this.readElements()[0];
      if (!root || !options.exact) return [];
      return root.children.filter(
        (child) => child.accessibleRole === role && child.accessibleName === options.name,
      );
    });
  }

  async waitFor(options: { state: string; timeout: number }): Promise<void> {
    if (this.readElements().some((element) => element.visible)) return;
    await this.waitHook?.(options);
    if (!this.readElements().some((element) => element.visible)) {
      const error = new Error(`Timeout ${options.timeout}ms exceeded`);
      error.name = 'TimeoutError';
      throw error;
    }
  }
}

function exactDialog(visible = true): ElementNode {
  return new ElementNode('DIV', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-owns': null,
  }, undefined, undefined, visible)
    .append(new ElementNode('H2', {}, 'heading', 'Too many requests'))
    .append(new ElementNode('BUTTON', {}, 'button', 'Got it'));
}

function foreignDialog(): ElementNode {
  return new ElementNode('DIV', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-owns': null,
  })
    .append(new ElementNode('H2', {}, 'heading', 'Sign in'))
    .append(new ElementNode('BUTTON', {}, 'button', 'Continue'));
}

function capturePage(
  initialDialogs: ElementNode[],
  waitHook?: (setDialogs: (dialogs: ElementNode[]) => void, options: { state: string; timeout: number }) => Promise<void>,
) {
  let dialogs = initialDialogs;
  const setDialogs = (next: ElementNode[]) => {
    dialogs = next;
  };
  const waitFor = vi.fn(async (options: { state: string; timeout: number }) => {
    await waitHook?.(setDialogs, options);
  });
  const waitForTimeout = vi.fn(async (timeout: number) => {
    await waitHook?.(setDialogs, { state: 'visible', timeout });
  });
  return {
    page: {
      locator: vi.fn(() => new Locator(() => dialogs, waitFor)),
      waitForTimeout,
    },
    waitFor,
    waitForTimeout,
  };
}

const sourceOptions = {
  observedAt: '2026-08-03T00:00:00.000Z',
  sourceLocalOccurrence: 'capture:test',
} as const;

describe('issue 1168 r20 Phase A capture wait', () => {
  it('captures an exact modal already visible at start without waiting', async () => {
    const fixture = capturePage([exactDialog()]);
    const source = await captureTooManyRequestsSourceWithWait(fixture.page, 250, sourceOptions);

    expect(source.shape.dialog.page_dialog_ordinal).toBe(0);
    expect(source.shape.heading.child_index_path).toEqual([0]);
    expect(source.shape.acknowledgement.child_index_path).toEqual([1]);
    expect(fixture.waitFor).not.toHaveBeenCalled();
  });

  it('waits for an exact modal that appears before the existing timeout', async () => {
    const fixture = capturePage([], async (setDialogs) => {
      setDialogs([exactDialog()]);
    });
    const source = await captureTooManyRequestsSourceWithWait(fixture.page, 321, sourceOptions);

    expect(source.shape.dialog.tag_name).toBe('div');
    expect(fixture.waitForTimeout).toHaveBeenCalledOnce();
    expect(fixture.waitForTimeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(321);
  });

  it('waits past hidden dialogs until one later dialog becomes visible', async () => {
    const fixture = capturePage([exactDialog(false), exactDialog(false)], async (setDialogs) => {
      setDialogs([exactDialog(true), exactDialog(false)]);
    });
    const source = await captureTooManyRequestsSourceWithWait(fixture.page, 321, sourceOptions);

    expect(source.shape.dialog.page_dialog_ordinal).toBe(0);
    expect(fixture.waitForTimeout).toHaveBeenCalledOnce();
  });

  it('returns modal_timeout when no visible dialog appears by the deadline', async () => {
    const fixture = capturePage([], async () => {});

    await expect(captureTooManyRequestsSourceWithWait(fixture.page, 17, sourceOptions))
      .rejects.toThrow('modal_timeout');
    expect(fixture.waitForTimeout).toHaveBeenCalled();
  });

  it('returns capture_ambiguous_visible_match for several visible dialogs', async () => {
    const fixture = capturePage([exactDialog(), exactDialog()]);

    await expect(captureTooManyRequestsSourceWithWait(fixture.page, 250, sourceOptions))
      .rejects.toThrow('capture_ambiguous_visible_match');
    expect(fixture.waitForTimeout).not.toHaveBeenCalled();
  });

  it('returns capture_ambiguous_visible_match for a foreign visible dialog', async () => {
    const fixture = capturePage([foreignDialog()]);

    await expect(captureTooManyRequestsSourceWithWait(fixture.page, 250, sourceOptions))
      .rejects.toThrow('capture_ambiguous_visible_match');
    expect(fixture.waitForTimeout).not.toHaveBeenCalled();
  });
});

describe('issue 1168 r20 capture terminal propagation', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-1168-capture-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    vi.resetModules();
    vi.doUnmock('./ui-adapter.ts');
    vi.doUnmock('./browser-session.ts');
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('preserves modal_timeout and writes diagnostics under profile-unresolved', async () => {
    const fixture = capturePage([], async () => {});
    vi.doMock('./ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'verified' })),
        loadChromium: vi.fn(() => ({})),
        openTurnPage: vi.fn(async () => ({ page: fixture.page, owned: true })),
      };
    });
    vi.doMock('./browser-session.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./browser-session.ts')>();
      return {
        ...actual,
        connectCdpBrowser: vi.fn(async () => ({})),
        closeOwnedTurnPage: vi.fn(async () => {}),
        releaseCdpBrowser: vi.fn(async () => {}),
      };
    });

    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const outputPath = join(root, 'captured-source.json');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    let exitCode: number;
    try {
      exitCode = await runCli([
        'turn',
        '--profile', join(root, 'profile'),
        '--cdp', 'not-a-valid-cdp-url',
        '--project-url', 'https://chatgpt.com/g/project-fixture',
        '--timeout-ms', '25',
        '--capture-too-many-requests-source', outputPath,
      ]);
    } finally {
      process.stdout.write = originalStdout;
    }

    const terminal = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(exitCode!).toBe(22);
    expect(terminal).toMatchObject({
      schema: 'control-result/v1',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'modal_timeout',
    });
    expect(terminal.cause).not.toBe('command_failed');
    expect(existsSync(outputPath)).toBe(false);
    const diagnosticId = String(terminal.driver_diagnostic_id ?? '');
    expect(diagnosticId).not.toBe('');
    const diagnostic = readDriverDiagnostic('profile-unresolved', diagnosticId);
    expect(diagnostic).toMatchObject({
      schema: 'driver-diagnostic/v1',
      configured_profile_key: 'profile-unresolved',
      cause: 'modal_timeout',
      exception_message: 'modal_timeout',
    });
  });
});
