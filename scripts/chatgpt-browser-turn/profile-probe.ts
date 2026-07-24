import { loadChromium, type BrowserConfig, verifyProfile } from './ui-adapter.ts';

export interface ProfileReadyProbe {
  readonly ready: boolean;
  readonly state: 'ready' | 'chrome_not_running' | 'profile_mismatch' | 'quota' | 'challenge' | 'login' | 'ui_contract_mismatch' | 'driver_error';
  readonly cause: string;
}

function wallFromText(text: string): ProfileReadyProbe | null {
  if (/verify you are human|checking your browser|just a moment|unusual activity/i.test(text)) {
    return { ready: false, state: 'challenge', cause: 'challenge_detected' };
  }
  if (/you(?:'|’)ve reached|usage limit|message limit|reached the current usage|please try again later/i.test(text)) {
    return { ready: false, state: 'quota', cause: 'quota_detected' };
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
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 20_000);
      const wall = wallFromText(body);
      if (wall) return wall;
      const composer = await page.locator('#prompt-textarea').count().catch(() => 0);
      if (composer > 0) composerSeen = true;
      if (!composer && /log in|sign in/i.test(body)) {
        return { ready: false, state: 'login', cause: 'login_required' };
      }
    }
    return composerSeen
      ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall' }
      : { ready: false, state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
  } catch {
    return { ready: false, state: 'driver_error', cause: 'profile_probe_failed' };
  }
}
