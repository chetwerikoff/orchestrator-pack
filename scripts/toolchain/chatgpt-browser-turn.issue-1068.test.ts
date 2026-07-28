import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDomainLock } from '../chatgpt-browser-turn/coordination.ts';
import {
  createFreshIdentityRetention,
  normalizeConversationUrl,
  observeFreshConversationUrl,
  resolveCanonicalFreshConversation,
  type BrowserConfig,
} from '../chatgpt-browser-turn/ui-adapter.ts';
import {
  configuredProfileIdentity,
  configuredProfileKey,
  legacyConfiguredProfileIdentity,
  legacyProfileKeyAmbiguous,
  profileDirs,
  profileNamespaceExists,
  profileStoreRoot,
  resolveConfiguredProfile,
} from '../chatgpt-browser-turn/storage-common.ts';
import {
  listReadableIncidents,
  profileStartupCompatibility,
  statusList,
  statusListForConfiguredProfile,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';

function conversationUrlFromPrefix(prefix: string, conversationUuid: string): string {
  return normalizeConversationUrl(`${prefix.replace(/\/+$/, '')}/c/${conversationUuid}`);
}

let root = '';
const cdp = 'http://127.0.0.1:9222';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function correlatedNetwork(userMessageId: string, conversationId: string): any {
  return {
    messages: [{ id: userMessageId, role: 'user', conversationId }],
    serviceSubmittedUserIds: new Set([userMessageId]),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-1068-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('issue 1068 profile identity and legacy keys', () => {
  it('AC4: native Linux case-distinct profile directories derive distinct keys', () => {
    if (process.platform === 'win32') return;
    const parent = join(root, 'case-parent');
    const upper = join(parent, 'ProfileCase');
    const lower = join(parent, 'profilecase');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    expect(configuredProfileKey(upper, cdp)).not.toBe(configuredProfileKey(lower, cdp));
    expect(configuredProfileIdentity(upper)).not.toBe(configuredProfileIdentity(lower));
  });

  it('AC4/AC5: CDP-owner normalization uses the same filesystem semantics', async () => {
    const ownerPath = join(repoRoot, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs');
    const owner = await import(pathToFileURL(ownerPath).href) as { normalizeProfilePath(path: string): string };
    if (process.platform !== 'win32') {
      const parent = join(root, 'owner-case');
      const upper = join(parent, 'OwnerProfile');
      const lower = join(parent, 'ownerprofile');
      mkdirSync(upper, { recursive: true });
      mkdirSync(lower, { recursive: true });
      expect(owner.normalizeProfilePath(upper)).not.toBe(owner.normalizeProfilePath(lower));
    }
    expect(owner.normalizeProfilePath('C:\\Users\\Automation\\Profile'))
      .toBe(owner.normalizeProfilePath('/mnt/c/users/automation/profile'));
  });

  it('AC5: deterministic Windows-drive and /mnt aliases stay stable', () => {
    const windows = 'C:\\Users\\Automation\\Profile';
    const wsl = '/mnt/c/Users/Automation/Profile';
    expect(configuredProfileKey(windows, cdp)).toBe(configuredProfileKey(wsl, cdp));
    expect(configuredProfileIdentity(windows)).toBe(configuredProfileIdentity(wsl));
  });

  it('AC8: unresolvable case-distinct spellings do not collapse via lexical lowercasing', () => {
    if (process.platform === 'win32') return;
    const parent = join(root, 'unresolved-parent');
    mkdirSync(parent, { recursive: true });
    const mixed = join(parent, 'MixedProfile');
    const folded = join(parent, 'mixedprofile');
    expect(configuredProfileKey(mixed, cdp)).not.toBe(configuredProfileKey(folded, cdp));
    expect(legacyConfiguredProfileIdentity(mixed)).toBe(legacyConfiguredProfileIdentity(folded));
  });

  it('AC6: active legacy possible_delivery blocks startup on the new key', () => {
    const profile = join(root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    expect(resolved.keysDiffer).toBe(true);
    writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy',
      cause: 'stream_timeout',
    });
    const blocked = profileStartupCompatibility(profile, cdp);
    expect(blocked?.state).toBe('profile_blocked');
    expect(blocked?.cause).toBe('legacy_profile_namespace_active');
    expect(blocked?.legacy_namespace_root).toBe(profileStoreRoot(resolved.legacyProfileKey));
  });

  it('AC9: status/list merges safety-bearing legacy namespace items', () => {
    const profile = join(root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const incident = writeIncident(resolved.legacyProfileKey, {
      kind: 'fresh_orphan',
      generation: 1,
      phase: 'possible_delivery',
      provisional_id: randomUUID(),
      cause: 'canonical_fresh_conversation_unproven',
    });
    const listed = statusListForConfiguredProfile(profile, cdp);
    expect(listed.legacy_configured_profile_key).toBe(resolved.legacyProfileKey);
    expect(listed.items?.some((item) => item.identity === incident.identity && item.kind === 'fresh_orphan')).toBe(true);
  });

  it('AC9: existing status and clear commands operate on a legacy incident', async () => {
    const profile = join(root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const incident = writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 3,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy-clear',
      cause: 'stream_timeout',
    });
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    await runCli(['status/list', '--profile', profile, '--cdp', cdp]);
    expect(chunks.join('')).toContain(incident.identity);
    chunks.length = 0;
    await runCli([
      'clear', '--profile', profile, '--cdp', cdp,
      '--identity', incident.identity,
      '--generation', String(incident.record.generation),
      '--evidence-token', incident.record.evidence_token,
    ]);
    write.mockRestore();
    expect(chunks.join('')).toContain('cleared');
    expect(listReadableIncidents(resolved.legacyProfileKey)).toHaveLength(0);
  });

  it('AC7: legacy safety classes refuse startup instead of using an empty new namespace', () => {
    const profile = join(root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const seeds: Array<() => (() => void) | void> = [
      () => { writeIncident(resolved.legacyProfileKey, {
        kind: 'conversation_incident',
        generation: 1,
        phase: 'possible_delivery',
        conversation_id: 'https://chatgpt.com/c/a',
        cause: 'stream_timeout',
      }); },
      () => { writeIncident(resolved.legacyProfileKey, {
        kind: 'profile_wall',
        generation: 1,
        phase: 'pre_send',
        cause: 'quota',
      }); },
      () => {
        const lock = acquireDomainLock(resolved.legacyProfileKey, 'fresh:legacy-lock');
        expect(lock).not.toBeNull();
        return () => lock?.release();
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).quarantine, 'legacy.opaque'), 'opaque');
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).tombstones, 'legacy.json'), '{}');
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).publications, `${randomUUID()}.json`), '{}');
      },
    ];
    for (const seed of seeds) {
      rmSync(join(root, 'state'), { recursive: true, force: true });
      process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
      const cleanup = seed();
      expect(profileStartupCompatibility(profile, cdp)?.cause).toBe('legacy_profile_namespace_active');
      expect(profileNamespaceExists(resolved.profileKey)).toBe(false);
      cleanup?.();
    }
  });

  it('AC7/AC10: diagnostic-only legacy bytes do not revive profile-wide admission', () => {
    const profile = join(root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    writeFileSync(join(profileDirs(resolved.legacyProfileKey).diagnostics, 'note.json'), '{}');
    expect(profileStartupCompatibility(profile, cdp)).toBeNull();

    const currentLock = acquireDomainLock(resolved.profileKey, 'fresh:independent');
    expect(currentLock).not.toBeNull();
    expect(statusList(resolved.profileKey).state).not.toBe('profile_blocked');
    currentLock?.release();
  });

  it('marks ambiguous when case-distinct siblings exist on native Linux', () => {
    if (process.platform === 'win32') return;
    const parent = join(root, 'ambiguous-parent');
    const upper = join(parent, 'ProfileA');
    const lower = join(parent, 'profilea');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    if (!existsSync(upper) || !existsSync(lower) || upper === lower) return;
    expect(legacyProfileKeyAmbiguous(upper)).toBe(true);
    const resolved = resolveConfiguredProfile(upper, cdp);
    writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      cause: 'stream_timeout',
    });
    expect(profileStartupCompatibility(upper, cdp)?.cause).toBe('legacy_profile_key_ambiguous');
  });

  it('resolves symlink aliases to the same configured profile key', () => {
    const actual = join(root, 'Profile-Actual');
    const alias = join(root, 'profile-alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'dir');
    expect(configuredProfileKey(actual, cdp)).toBe(configuredProfileKey(alias, cdp));
  });
});

describe('issue 1068 fresh canonical identity retention', () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-fixture/project';
  const conversationUuid = '6a65acd9-4d44-83ec-bcb9-5787832fac24';
  const inProjectConversation = `https://chatgpt.com/g/g-p-fixture/project/c/${conversationUuid}`;
  const outOfProjectConversation = `https://chatgpt.com/c/${conversationUuid}`;

  it('AC2: byte-identical in-project identity from URL and correlator fallback', () => {
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retention = createFreshIdentityRetention();
    observeFreshConversationUrl(retention, inProjectConversation, projectUrl);
    const fromUrl = resolveCanonicalFreshConversation(
      config,
      retention,
      { url: () => inProjectConversation },
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromUrl).toBe(inProjectConversation);

    const fallback = createFreshIdentityRetention();
    const fromCorrelator = resolveCanonicalFreshConversation(
      config,
      fallback,
      undefined,
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromCorrelator).toBe(conversationUrlFromPrefix(normalizeConversationUrl(projectUrl), conversationUuid));
    expect(fromCorrelator).toBe(inProjectConversation);
  });

  it('AC2: byte-identical out-of-project identity uses observed URL prefix', () => {
    const userMessageId = 'user-owned-12345678';
    const retention = createFreshIdentityRetention();
    observeFreshConversationUrl(retention, outOfProjectConversation, projectUrl);
    const fromCorrelator = resolveCanonicalFreshConversation(
      { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 },
      retention,
      { url: () => outOfProjectConversation },
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromCorrelator).toBe(outOfProjectConversation);
  });

  it('AC2/AC3: fails closed without an own unambiguous service correlator or provable prefix', () => {
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const noCorrelator = createFreshIdentityRetention();
    observeFreshConversationUrl(noCorrelator, inProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(config, noCorrelator, undefined, correlatedNetwork('foreign-user', conversationUuid), userMessageId))
      .toBeUndefined();

    const conflictingPrefixes = createFreshIdentityRetention();
    observeFreshConversationUrl(conflictingPrefixes, inProjectConversation, projectUrl);
    observeFreshConversationUrl(conflictingPrefixes, outOfProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(
      config,
      conflictingPrefixes,
      undefined,
      correlatedNetwork(userMessageId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      userMessageId,
    )).toBeUndefined();
  });

  it('AC2/AC3: promotion is durable through its callback and monotonic across conflicts', () => {
    const retained: string[] = [];
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retention = createFreshIdentityRetention((identity) => retained.push(identity));
    observeFreshConversationUrl(retention, inProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(
      config,
      retention,
      undefined,
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    )).toBe(inProjectConversation);
    expect(retained).toEqual([inProjectConversation]);
    expect(resolveCanonicalFreshConversation(
      config,
      retention,
      { url: () => { throw new Error('page_url_unreadable'); } },
      correlatedNetwork(userMessageId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      userMessageId,
    )).toBe(inProjectConversation);
    expect(retained).toEqual([inProjectConversation]);
  });

  it('AC3: concurrent fresh-turn retention handles cannot steal each other\'s identity', () => {
    const uuidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const uuidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const userA = 'user-concurrent-a-12345678';
    const userB = 'user-concurrent-b-12345678';
    const urlA = `https://chatgpt.com/c/${uuidA}`;
    const urlB = `https://chatgpt.com/c/${uuidB}`;
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retentionA = createFreshIdentityRetention();
    const retentionB = createFreshIdentityRetention();
    observeFreshConversationUrl(retentionA, urlA, projectUrl);
    observeFreshConversationUrl(retentionB, urlB, projectUrl);
    expect(resolveCanonicalFreshConversation(config, retentionA, undefined, correlatedNetwork(userA, uuidA), userA)).toBe(urlA);
    expect(resolveCanonicalFreshConversation(config, retentionB, undefined, correlatedNetwork(userB, uuidB), userB)).toBe(urlB);
    expect(resolveCanonicalFreshConversation(config, retentionA, undefined, correlatedNetwork(userB, uuidB), userB)).toBe(urlA);
  });

});
