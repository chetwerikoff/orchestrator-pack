import { loadChromium, type BrowserConfig, verifyProfile } from './ui-adapter.ts';

export interface ProfileReadyProbe {
  readonly ready: boolean;
  readonly state: 'ready' | 'chrome_not_running' | 'profile_mismatch' | 'quota' | 'challenge' | 'login' | 'ui_contract_mismatch' | 'driver_error';
  readonly cause: string;
}

async function productStatusText(page: any): Promise<{ text: string; composer: boolean }> {
  const composer = (await page.locator('#prompt-textarea').count().catch(() => 0)) > 0;
  const selectors = [
    '[role="alert"]',
    '[role="dialog"]',
    '[data-testid*="quota"]',
    '[data-testid*="limit"]',
    '[data-testid*="challenge"]',
    '[data-testid*="login"]',
  ];
  const parts: string[] = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let index = 0; index < count; index++) {
      const text = await locator.nth(index).innerText().catch(() => '');
      if (text) parts.push(text);
    }
  }
  if (!composer) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 20_000);
    if (body) parts.push(body);
  }
  return { text: parts.join('\n'), composer };
}

function wallFromSurface(text: string, composer: boolean): ProfileReadyProbe | null {
  if (/verify you are human|checking your browser|just a moment|unusual activity/i.test(text)) {
    return { ready: false, state: 'challenge', cause: 'challenge_detected' };
  }
  if (/you(?:'|’)ve reached|usage limit|message limit|reached the current usage|please try again later/i.test(text)) {
    return { ready: false, state: 'quota', cause: 'quota_detected' };
  }
  if (!composer && /log in|sign in/i.test(text)) {
    return { ready: false, state: 'login', cause: 'login_required' };
  }
  return null;
}

export async function probeProfileReady(config: BrowserConfig): Promise<ProfileReadyProbe> {
  const verification = await verifyProfile(config);
  if (verification.state === 'unavailable') {
    return { ready: false, state: 'chrome_not_running', cause: verification.cause };
  }
  if (verification.state !== 'verified') {
    return { ready: false, state: 'profile_mismatch', cause: verification.cause };
  }

  try {
    const chromium = loadChromium();
    const browser = await chromium.connectOverCDP(config.cdp);
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      return { ready: false, state: 'ui_contract_mismatch', cause: 'context_count' };
    }
    const pages = contexts[0].pages();
    if (pages.length === 0) {
      return { ready: false, state: 'ui_contract_mismatch', cause: 'no_existing_page' };
    }
    let composerSeen = false;
    for (const page of pages) {
      const surface = await productStatusText(page);
      const wall = wallFromSurface(surface.text, surface.composer);
      if (wall) return wall;
      if (surface.composer) composerSeen = true;
    }
    return composerSeen
      ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall' }
      : { ready: false, state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
  } catch {
    return { ready: false, state: 'driver_error', cause: 'profile_probe_failed' };
  }
}
