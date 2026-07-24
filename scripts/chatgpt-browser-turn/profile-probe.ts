import {
  classifyProductWall,
  loadChromium,
  productStatusText,
  type BrowserConfig,
  verifyProfile,
} from './ui-adapter.ts';

export interface ProfileReadyProbe {
  readonly ready: boolean;
  readonly state: 'ready' | 'chrome_not_running' | 'profile_mismatch' | 'quota' | 'challenge' | 'login' | 'ui_contract_mismatch' | 'driver_error';
  readonly cause: string;
}

async function probePage(page: any): Promise<ProfileReadyProbe | { ready: true; state: 'ready'; cause: 'composer_ready_no_wall' } | null> {
  const surface = await productStatusText(page);
  const wall = classifyProductWall(surface);
  if (wall.state) return { ready: false, state: wall.state, cause: wall.cause! };
  return surface.composer ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall' } : null;
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
    if (contexts.length !== 1) return { ready: false, state: 'ui_contract_mismatch', cause: 'context_count' };
    const pages = contexts[0].pages();
    if (pages.length === 0) return { ready: false, state: 'ui_contract_mismatch', cause: 'no_existing_page' };

    let ready = false;
    for (const page of pages) {
      const observation = await probePage(page);
      if (observation?.ready === false) return observation;
      if (observation?.ready) ready = true;
    }
    return ready
      ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall' }
      : { ready: false, state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
  } catch {
    return { ready: false, state: 'driver_error', cause: 'profile_probe_failed' };
  }
}
