import { releaseCdpBrowser } from './browser-session.ts';
import {
  classifyProductWall,
  loadChromium,
  productStatusText,
  type BrowserConfig,
  verifyProfile,
} from './ui-adapter.ts';

export interface ProfileReadyProbe {
  readonly ready: boolean;
  readonly state: 'ready' | 'chrome_not_running' | 'profile_mismatch' | 'ui_contract_mismatch' | 'driver_error';
  readonly cause: string;
  readonly product_wall_diagnostic?: { readonly wall_kind: string; readonly matched_text: string; readonly matched_selector: string };
}

async function probePage(page: any): Promise<ProfileReadyProbe | null> {
  const surface = await productStatusText(page);
  const wall = classifyProductWall(surface);
  // Execute-Issue recovery is conversation-local post-send evidence, not a
  // profile-level readiness blocker. Profile probing therefore ignores that
  // projection and keeps the existing composer-readiness semantics.
  if (wall.state === 'recovery_required') {
    return surface.composer ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall' } : null;
  }
  const diagnostic = 'wall_kind' in wall && wall.wall_kind !== 'none' ? { product_wall_diagnostic: wall } : {};
  return surface.composer
    ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall', ...diagnostic }
    : { ready: false, state: 'ui_contract_mismatch', cause: 'composer_unavailable', ...diagnostic };
}

export async function probeProfileReady(config: BrowserConfig): Promise<ProfileReadyProbe> {
  const verification = await verifyProfile(config);
  if (verification.state === 'unavailable') {
    return { ready: false, state: 'chrome_not_running', cause: verification.cause };
  }
  if (verification.state !== 'verified') {
    return { ready: false, state: 'profile_mismatch', cause: verification.cause };
  }

  let browser: unknown;
  try {
    const chromium = loadChromium();
    browser = await chromium.connectOverCDP(config.cdp);
    const contexts = (browser as { contexts: () => unknown[] }).contexts();
    if (contexts.length !== 1) return { ready: false, state: 'ui_contract_mismatch', cause: 'context_count' };
    const pages = (contexts[0] as { pages: () => unknown[] }).pages();
    if (pages.length === 0) return { ready: false, state: 'ui_contract_mismatch', cause: 'no_existing_page' };

    let ready = false;
    let productWallDiagnostic: ProfileReadyProbe['product_wall_diagnostic'];
    for (const page of pages) {
      const observation = await probePage(page);
      if (observation?.ready === false) return observation;
      if (observation?.ready) ready = true;
      if (observation?.product_wall_diagnostic) productWallDiagnostic = observation.product_wall_diagnostic;
    }
    return ready
      ? { ready: true, state: 'ready', cause: 'composer_ready_no_wall', ...(productWallDiagnostic ? { product_wall_diagnostic: productWallDiagnostic } : {}) }
      : { ready: false, state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
  } catch {
    return { ready: false, state: 'driver_error', cause: 'profile_probe_failed' };
  } finally {
    await releaseCdpBrowser(browser);
  }
}
