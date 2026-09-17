import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOpsWiki,
  buildEscalationQueries,
  checkRepositoryMode,
  collectHeadings,
  createMcpWikiOpsClient,
  defaultGitRunner,
  episodeRelativePath,
  evaluateEpisodeRead,
  evaluateOperationalFreshness,
  evaluateSearchEscalation,
  extractSection,
  loadGoldenSuite,
  loadManifest,
  OPS_WIKI_GOLDEN_RELATIVE,
  OPS_WIKI_MANIFEST_RELATIVE,
  OPS_WIKI_STATUS_NOTE,
  parseStatusNote,
  planEpisodes,
  renderEpisode,
  renderStatusNote,
  sha256,
  type GitRunner,
  type OpsWikiManifest,
  type WikiOpsClient,
  type WikiOpsReadResult,
  type WikiOpsSearchHit,
} from './sync-ops-wiki.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ops-wiki-test',
      GIT_AUTHOR_EMAIL: 'ops-wiki-test@example.test',
      GIT_COMMITTER_NAME: 'ops-wiki-test',
      GIT_COMMITTER_EMAIL: 'ops-wiki-test@example.test',
    },
  });
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function initRepo(files: Record<string, string>): { repoRoot: string; commit: string } {
  const repoRoot = tempDir('ops-wiki-repo-');
  git(repoRoot, ['init']);
  git(repoRoot, ['checkout', '-b', 'main']);
  for (const [path, content] of Object.entries(files)) write(repoRoot, path, content);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'fixture']);
  return { repoRoot, commit: git(repoRoot, ['rev-parse', 'HEAD']).trim() };
}

function fixtureFiles(body = 'worker must pass pre-flight before implementation.\n'): Record<string, string> {
  return {
    'AGENTS.md': [
      '# AGENTS.md',
      '',
      '## Precedence',
      '',
      'Issue then AGENTS.md.',
      '',
      '## Edit boundaries',
      '',
      'Never edit vendor/**.',
      '',
    ].join('\n'),
    'docs/runbook.md': [
      '# Runbook',
      '',
      '## Worker lifecycle',
      '',
      body,
      '',
      '```',
      '# fake heading in fence',
      '```',
      '',
      '## Completion authority',
      '',
      'Published artifact is completion authority.',
      '',
    ].join('\n'),
    'scripts/worker-smoke-run.ts': 'export const smoke = true;\n',
  };
}

function fixtureManifest(overrides: Partial<OpsWikiManifest> = {}): OpsWikiManifest {
  return loadManifest(JSON.stringify({
    schema_version: 1,
    source_repo: 'chetwerikoff/orchestrator-pack',
    max_episode_bytes: 12288,
    weak_top1_score: 0.5,
    ambiguity_max_score_delta: 0.05,
    episodes: [
      {
        episode_id: 'worker-lifecycle',
        title: 'Worker lifecycle',
        path: 'docs/runbook.md',
        aliases: ['pre-flight', 'воркер'],
        topic: 'worker',
        role: 'worker',
        sections: [
          { heading: '## Worker lifecycle' },
          { heading: '## Completion authority' },
        ],
        referenced_paths: ['scripts/worker-smoke-run.ts'],
        edges: [{ type: 'related', target: 'agents-boundaries' }],
      },
      {
        episode_id: 'agents-boundaries',
        title: 'Edit boundaries',
        path: 'AGENTS.md',
        sections: [
          { heading: '## Precedence' },
          { heading: '## Edit boundaries' },
        ],
        edges: [{ type: 'related', target: 'worker-lifecycle' }],
      },
    ],
    ...overrides,
  }));
}

function writeManifestAndGolden(repoRoot: string, manifest = fixtureManifest()): void {
  write(repoRoot, OPS_WIKI_MANIFEST_RELATIVE, JSON.stringify(manifest, null, 2));
  write(repoRoot, OPS_WIKI_GOLDEN_RELATIVE, JSON.stringify({
    queries: [
      { id: 'primary', query: 'procedure', expected_episode_ids: [manifest.episodes[0]!.episode_id] },
    ],
  }));
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'manifest']);
}

function recordingGit(repoRoot: string, corpusRoot: string): { git: GitRunner; cwds: string[] } {
  const cwds: string[] = [];
  return {
    cwds,
    git: (cwd, args) => {
      cwds.push(cwd);
      expect(cwd).not.toBe(corpusRoot);
      expect(cwd).toBe(repoRoot);
      return defaultGitRunner(cwd, args);
    },
  };
}

function corpusClient(corpusRoot: string, options: {
  readonly unavailable?: boolean;
  readonly timeout?: boolean;
  readonly failStatusTimes?: number;
  readonly lagMs?: number;
  readonly onRead?: (path: string) => void;
  readonly searchImpl?: (input: { query?: string }) => WikiOpsSearchHit[] | WikiOpsReadResult;
} = {}): WikiOpsClient & { readonly statusReads: number } {
  const state = { statusReads: 0 };
  const client: WikiOpsClient & { readonly statusReads: number } = {
    get statusReads() {
      return state.statusReads;
    },
    async read(path) {
      options.onRead?.(path);
      if (options.unavailable) return { ok: false, reason: 'unavailable' };
      if (options.timeout) return { ok: false, reason: 'timeout' };
      if (path === OPS_WIKI_STATUS_NOTE) {
        state.statusReads += 1;
        if (options.failStatusTimes && state.statusReads <= options.failStatusTimes) {
          return { ok: false, reason: 'timeout' };
        }
      }
      const absolute = join(corpusRoot, path);
      try {
        const content = readFileSync(absolute, 'utf8');
        return { ok: true, path, content };
      } catch {
        return { ok: false, reason: 'absent' };
      }
    },
    async search(input) {
      if (options.unavailable) return { ok: false, reason: 'unavailable' };
      if (options.searchImpl) return options.searchImpl(input);
      const query = (input.query ?? '').toLowerCase();
      const hits: WikiOpsSearchHit[] = [];
      const dir = join(corpusRoot, 'episodes');
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.md')) continue;
          const path = `episodes/${name}`;
          const content = readFileSync(join(corpusRoot, path), 'utf8');
          hits.push({ path, score: 0.9, title: name.replace(/\.md$/, '') });
        }
      } catch {
        // no episodes yet
      }
      if (hits.length === 0 && query) hits.push({ path: episodeRelativePath('worker-lifecycle'), score: 0.9, title: 'Worker lifecycle' });
      return hits.slice(0, input.limit ?? 3);
    },
    async reindex() {
      if (options.unavailable) throw new Error('timeout');
    },
  };
  return client;
}

describe('ops-wiki extraction', () => {
  it('ignores fenced headings and preserves section order in merge groups', () => {
    const text = fixtureFiles()['docs/runbook.md']!;
    expect(collectHeadings(text).map((hit) => hit.token)).toEqual([
      '# Runbook',
      '## Worker lifecycle',
      '## Completion authority',
    ]);
    const worker = extractSection(text, '## Worker lifecycle');
    expect(worker).toContain('pre-flight');
    expect(worker).not.toContain('Completion authority');
    const merged = `${extractSection(text, '## Worker lifecycle')}\n\n${extractSection(text, '## Completion authority')}`;
    expect(merged.indexOf('pre-flight')).toBeLessThan(merged.indexOf('completion authority'));
  });

  it('rejects unresolved, ambiguous, and oversized selectors', () => {
    const text = '# Doc\n\n## Same\n\nA\n\n## Same\n\nB\n';
    expect(() => extractSection(text, '## Missing')).toThrow(/ops_wiki_unresolved_selector/u);
    expect(() => extractSection(text, '## Same')).toThrow(/ops_wiki_ambiguous_selector/u);
    const { repoRoot, commit } = initRepo(fixtureFiles('x'.repeat(13000)));
    writeManifestAndGolden(repoRoot);
    const manifest = fixtureManifest();
    expect(() => planEpisodes(repoRoot, commit, manifest)).toThrow(/ops_wiki_episode_over_byte_ceiling:worker-lifecycle/u);
  });

  it('embeds provenance frontmatter and derived hashes, not author-maintained content hashes', () => {
    const { repoRoot, commit } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const manifest = fixtureManifest();
    const [episode] = planEpisodes(repoRoot, head, manifest);
    expect(episode!.markdown).toContain('ops_wiki_owned: true');
    expect(episode!.markdown).toContain(`source_commit: "${head}"`);
    expect(episode!.sourceHash).toBe(sha256(readFileSync(join(repoRoot, 'docs/runbook.md'), 'utf8')));
    expect(episode!.extractionHash).toHaveLength(64);
    expect(JSON.stringify(manifest)).not.toContain(episode!.extractionHash);
  });
});

describe('ops-wiki repository check', () => {
  it('fails missing referenced script paths and does not require a corpus', () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot, fixtureManifest({
      episodes: [
        {
          ...fixtureManifest().episodes[0]!,
          referenced_paths: ['scripts/missing-smoke.ts'],
        },
        fixtureManifest().episodes[1]!,
      ],
    }));
    expect(() => checkRepositoryMode({ repoRoot, commitRef: 'HEAD' })).toThrow(/ops_wiki_missing_referenced_path/u);
  });

  it('loads the tracked production manifest constants and golden suite', () => {
    const packRoot = join(import.meta.dirname, '..');
    const manifest = loadManifest(readFileSync(join(packRoot, OPS_WIKI_MANIFEST_RELATIVE), 'utf8'));
    expect(manifest.max_episode_bytes).toBe(12288);
    expect(manifest.weak_top1_score).toBe(0.5);
    expect(manifest.ambiguity_max_score_delta).toBe(0.05);
    const golden = loadGoldenSuite(readFileSync(join(packRoot, OPS_WIKI_GOLDEN_RELATIVE), 'utf8'));
    expect(golden.queries.length).toBeGreaterThan(3);
    const ids = new Set(manifest.episodes.map((episode) => episode.episode_id));
    for (const query of golden.queries) {
      for (const episodeId of query.expected_episode_ids) expect(ids.has(episodeId)).toBe(true);
    }
  });
});

describe('ops-wiki apply', () => {
  it('reads committed bytes, not a dirty working tree, and binds the actual HEAD', async () => {
    const { repoRoot } = initRepo(fixtureFiles('committed worker text\n'));
    writeManifestAndGolden(repoRoot);
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    write(repoRoot, 'docs/runbook.md', readFileSync(join(repoRoot, 'docs/runbook.md'), 'utf8').replace('committed worker text', 'dirty worker text'));
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const { git: gitRunner, cwds } = recordingGit(repoRoot, corpusRoot);
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: head,
      corpusRoot,
      git: gitRunner,
      client: corpusClient(corpusRoot),
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ ok: true, commit: head, searchable: true });
    expect(readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8')).toContain('committed worker text');
    expect(readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8')).not.toContain('dirty worker text');
    expect(cwds.every((cwd) => cwd === repoRoot)).toBe(true);
  });

  it('publishes apply_in_progress and confirms it before episode mutation', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const seen: string[] = [];
    const client = corpusClient(corpusRoot, {
      onRead: (path) => {
        if (path === OPS_WIKI_STATUS_NOTE) {
          seen.push(existsSyncEpisode() ? 'episodes-present' : 'episodes-absent');
        }
      },
    });
    function existsSyncEpisode(): boolean {
      try {
        readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8');
        return true;
      } catch {
        return false;
      }
    }
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client,
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe('episodes-absent');
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).checkedThrough).toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim());
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).applyInProgress).toBeUndefined();
  });

  it('leaves apply_in_progress visible when index confirmation times out before mutation', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot, { timeout: true }),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ ok: false, searchable: false, mutationBegan: false });
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).applyInProgress).toHaveLength(40);
    expect(() => readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8')).toThrow();
  });

  it('is a no-op for an already checked commit and status-only for an irrelevant later commit', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const first = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(first).toMatchObject({ ok: true, status: 'applied' });
    const repeat = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(repeat).toMatchObject({ ok: true, status: 'no_op', searchable: true });
    write(repoRoot, 'UNRELATED.md', 'not a declared source\n');
    git(repoRoot, ['add', 'UNRELATED.md']);
    git(repoRoot, ['commit', '-m', 'unrelated']);
    const later = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const statusOnly = await applyOpsWiki({
      repoRoot,
      commitRef: later,
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(statusOnly).toMatchObject({ ok: true, status: 'status_only', commit: later });
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).checkedThrough).toBe(later);
  });

  it('updates, adds, and deletes owned notes while preserving foreign files and dotfiles', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    write(corpusRoot, 'foreign.md', 'leave me\n');
    write(corpusRoot, '.obsidian-hybrid-search.db', 'db');
    write(corpusRoot, '.obsidian-hybrid-search.db-wal', 'wal');
    const remaining = {
      ...fixtureManifest().episodes[1]!,
      edges: [],
    };
    writeManifestAndGolden(repoRoot, loadManifest(JSON.stringify({
      schema_version: 1,
      source_repo: 'chetwerikoff/orchestrator-pack',
      max_episode_bytes: 12288,
      weak_top1_score: 0.5,
      ambiguity_max_score_delta: 0.05,
      episodes: [remaining],
    })));
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.removedEpisodeIds).toContain('worker-lifecycle');
    expect(() => readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8')).toThrow();
    expect(readFileSync(join(corpusRoot, 'foreign.md'), 'utf8')).toBe('leave me\n');
    expect(readFileSync(join(corpusRoot, '.obsidian-hybrid-search.db'), 'utf8')).toBe('db');
  });

  it('rejects Synto vault targets, path escape, and pre-mutation render failures without touching a mixed corpus', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const synto = tempDir('synto-vault-');
    await expect(applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot: synto,
      syntoVault: synto,
      client: corpusClient(synto),
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('ops_wiki_synto_vault_rejected') });
    expect(() => planEpisodes(repoRoot, git(repoRoot, ['rev-parse', 'HEAD']).trim(), fixtureManifest(), (cwd, args) => {
      if (args[0] === 'cat-file' && String(args[2] ?? '').includes('..')) return { ok: false, stdout: '', stderr: '' };
      return defaultGitRunner(cwd, args);
    })).not.toThrow(/path_escape/u);
    expect(() => loadManifest(JSON.stringify({
      ...fixtureManifest(),
      episodes: [{ ...fixtureManifest().episodes[0], path: '../secret.md' }],
    }))).toThrow(/ops_wiki_path_escape/u);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    write(repoRoot, OPS_WIKI_MANIFEST_RELATIVE, '{not-json');
    git(repoRoot, ['add', OPS_WIKI_MANIFEST_RELATIVE]);
    git(repoRoot, ['commit', '-m', 'break manifest']);
    const failed = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot),
      git: recordingGit(repoRoot, corpusRoot).git,
    });
    expect(failed).toMatchObject({ ok: false, mutationBegan: false });
    expect(() => readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).toThrow();
  });

  it('operates on a corpus without .git and reports mid-apply degradation from golden/index failure', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const failed = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot, {
        searchImpl: () => ({ ok: false, reason: 'unavailable' }),
      }),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(failed).toMatchObject({ ok: false, mutationBegan: true, searchable: false });
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8')).applyInProgress).toHaveLength(40);
    expect(failed.ok === false && failed.checkedThrough).toBeUndefined();
  });

  it('asks the existing client for recovery reindex without inventing a second indexer', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    let reindexed = 0;
    const client = corpusClient(corpusRoot);
    const wrapped: WikiOpsClient = {
      read: client.read,
      search: client.search,
      async reindex() {
        reindexed += 1;
      },
    };
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: wrapped,
      git: recordingGit(repoRoot, corpusRoot).git,
      reindex: 'full',
      convergenceTimeoutMs: 200,
      pollIntervalMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(reindexed).toBe(1);
  });
});

describe('ops-wiki routing policy', () => {
  const policy = { weak_top1_score: 0.5, ambiguity_max_score_delta: 0.05 };
  const commit = 'a'.repeat(40);
  const status = (body: string): WikiOpsReadResult => ({ ok: true, path: OPS_WIKI_STATUS_NOTE, content: body });

  it('uses wiki-ops only for exact current-clean status', () => {
    const clean = renderStatusNote({ checkedThrough: commit });
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: status(clean) })).toBe('use_wiki_ops');
    expect(evaluateOperationalFreshness({
      currentCommit: commit,
      read: status(renderStatusNote({ checkedThrough: commit, applyInProgress: 'b'.repeat(40) })),
    })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: 'b'.repeat(40), read: status(clean) })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: false, reason: 'absent' } })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: false, reason: 'timeout' } })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: false, reason: 'unavailable' } })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: true, path: OPS_WIKI_STATUS_NOTE, content: 'not-status' } })).toBe('canonical_files');
  });

  it('escalates on absent, weak, ambiguous, and invalid reads', () => {
    expect(evaluateSearchEscalation([], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md' }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.4 }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.51 }, { path: 'episodes/b.md', score: 0.5 }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.9 }, { path: 'episodes/b.md', score: 0.4 }], policy)).toBe('read_top1');
    const episode = {
      episode_id: 'worker-lifecycle',
      relativePath: episodeRelativePath('worker-lifecycle'),
      title: 'Worker lifecycle',
      markdown: 'x',
      body: 'x',
      sourcePath: 'docs/runbook.md',
      sourceSections: ['## Worker lifecycle'],
      sourceHash: 'h',
      extractionHash: 'h',
      aliases: [],
      edges: [],
      referencedPaths: [],
    };
    expect(evaluateEpisodeRead({ read: { ok: false, reason: 'absent' }, episode })).toBe('expand');
    expect(evaluateEpisodeRead({ read: { ok: true, path: episode.relativePath, content: '' }, episode })).toBe('expand');
    expect(evaluateEpisodeRead({
      read: { ok: true, path: episode.relativePath, content: '---\nops_wiki_owned: true\nepisode_id: "other"\n---\n' },
      episode,
    })).toBe('expand');
    expect(evaluateEpisodeRead({
      read: { ok: true, path: episode.relativePath, content: '---\nops_wiki_owned: true\nepisode_id: "worker-lifecycle"\n---\n\n## Worker lifecycle\n' },
      episode,
    })).toBe('read_top1');
  });

  it('builds 2-4 distinct RU/EN escalation queries without duplicate padding', () => {
    const queries = buildEscalationQueries('что воркер должен сделать');
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('ops-wiki MCP client seam', () => {
  it('maps tool-call payloads through the injectable production client', async () => {
    const calls: string[] = [];
    const client = createMcpWikiOpsClient('http://wiki-ops.test/mcp', async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls.push(body.method);
      const payload = body.method === 'tools/call'
        ? { result: { content: [{ type: 'text', text: JSON.stringify({ found: true, content: renderStatusNote({ checkedThrough: 'c'.repeat(40) }) }) }] } }
        : { result: { protocolVersion: '2024-11-05' } };
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, ...payload })}\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
      });
    });
    const read = await client.read(OPS_WIKI_STATUS_NOTE, { related: false });
    expect(read.ok).toBe(true);
    expect(calls).toContain('initialize');
    expect(calls).toContain('tools/call');
  });
});
