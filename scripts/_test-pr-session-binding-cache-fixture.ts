import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import {
  BINDING_SOURCE_PUSH_REGISTER,
  createDefaultPrSessionBindingCache,
  registerPrSessionBindingRecord,
  writePrSessionBindingCacheFile,
} from '../docs/pr-session-binding-cache.mjs';

let isolatedBindingCachePath = '';
let isolatedBindingCacheDir = '';

export function getIsolatedBindingCachePath(): string {
  return isolatedBindingCachePath;
}

export function seedPrSessionBindingCache(
  sessionId: string,
  prNumber: number,
  headSha = '',
  repoSlug = 'chetwerikoff/orchestrator-pack',
) {
  const store = createDefaultPrSessionBindingCache();
  registerPrSessionBindingRecord(
    store,
    {
      sessionId,
      prNumber,
      repoSlug,
      headSha,
      source: BINDING_SOURCE_PUSH_REGISTER,
    },
    Date.now(),
  );
  writePrSessionBindingCacheFile(isolatedBindingCachePath, store);
}

export function useIsolatedPrSessionBindingCache() {
  beforeEach(() => {
    isolatedBindingCacheDir = mkdtempSync(path.join(tmpdir(), 'pr-session-binding-cache-'));
    isolatedBindingCachePath = path.join(isolatedBindingCacheDir, 'cache.json');
    writeFileSync(isolatedBindingCachePath, JSON.stringify(createDefaultPrSessionBindingCache()), 'utf8');
    process.env.AO_PR_SESSION_BINDING_CACHE = isolatedBindingCachePath;
  });

  afterEach(() => {
    delete process.env.AO_PR_SESSION_BINDING_CACHE;
    if (isolatedBindingCacheDir) {
      rmSync(isolatedBindingCacheDir, { recursive: true, force: true });
      isolatedBindingCacheDir = '';
      isolatedBindingCachePath = '';
    }
  });
}
