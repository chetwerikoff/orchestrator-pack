import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
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
  renderStatusNote,
  runGoldenSuite,
  sha256,
  type GitRunner,
  type OpsWikiManifest,
  type RenderedEpisode,
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
  const result = runProcessSync({
    command: 'git',
    args: [...args],
    cwd,
    inheritParentEnv: true,
    env: {
      GIT_AUTHOR_NAME: 'ops-wiki-test',
      GIT_AUTHOR_EMAIL: 'ops-wiki-test@example.test',
      GIT_COMMITTER_NAME: 'ops-wiki-test',
      GIT_COMMITTER_EMAIL: 'ops-wiki-test@example.test',
    },
  });
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function servedBody(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/u.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
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
      '```text',
      '# fake heading in backtick fence',
      '```',
      '',
      '~~~text',
      '## fake heading in tilde fence',
      '~~~',
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

function writeManifestAndGolden(
  repoRoot: string,
  manifest = fixtureManifest(),
  expectedEpisodeIds: readonly string[] = [manifest.episodes[0]!.episode_id],
): string {
  write(repoRoot, OPS_WIKI_MANIFEST_RELATIVE, JSON.stringify(manifest, null, 2));
  write(repoRoot, OPS_WIKI_GOLDEN_RELATIVE, JSON.stringify({
    queries: [{ id: 'primary', query: 'procedure', expected_episode_ids: expectedEpisodeIds }],
  }, null, 2));
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'manifest']);
  return git(repoRoot, ['rev-parse', 'HEAD']).trim();
}

function recordingGit(repoRoot: string, corpusRoot: string): { git: GitRunner; cwds: string[] } {
  const cwds: string[] = [];
  return {
    cwds,
    git: (cwd, args) => {
      cwds.push(cwd);
      expect(cwd).toBe(repoRoot);
      expect(cwd).not.toBe(corpusRoot);
      return defaultGitRunner(cwd, args);
    },
  };
}

function corpusClient(corpusRoot: string, options: {
  readonly unavailable?: boolean;
  readonly timeout?: boolean;
  readonly searchImpl?: (input: { query?: string }) => WikiOpsSearchHit[] | WikiOpsReadResult;
} = {}): WikiOpsClient {
  return {
    async read(path) {
      if (options.unavailable) return { ok: false, reason: 'unavailable' };
      if (options.timeout) return { ok: false, reason: 'timeout' };
      try {
        const content = readFileSync(join(corpusRoot, path), 'utf8');
        return { ok: true, path, content: servedBody(content) };
      } catch {
        return { ok: false, reason: 'absent' };
      }
    },
    async search(input) {
      if (options.unavailable) return { ok: false, reason: 'unavailable' };
      if (options.searchImpl) return options.searchImpl(input);
      const hits: WikiOpsSearchHit[] = [];
      try {
        for (const name of readdirSync(join(corpusRoot, 'episodes'))) {
          if (!name.endsWith('.md')) continue;
          hits.push({ path: `episodes/${name}`, score: 0.9, title: name.replace(/\.md$/u, '') });
        }
      } catch {
        // no episodes yet
      }
      return hits.slice(0, input.limit ?? 3);
    },
    async reindex() {
      if (options.unavailable) throw new Error('unavailable');
    },
  };
}

async function applyFixture(repoRoot: string, corpusRoot: string, commitRef = 'HEAD', client = corpusClient(corpusRoot)) {
  return applyOpsWiki({
    repoRoot,
    commitRef,
    corpusRoot,
    client,
    git: recordingGit(repoRoot, corpusRoot).git,
    convergenceTimeoutMs: 100,
    pollIntervalMs: 1,
  });
}

describe('ops-wiki extraction and repository check', () => {
  it('ignores both Markdown fence kinds and preserves section order', () => {
    const text = fixtureFiles()['docs/runbook.md']!;
    expect(collectHeadings(text).map((hit) => hit.token)).toEqual([
      '# Runbook',
      '## Worker lifecycle',
      '## Completion authority',
    ]);
    const worker = extractSection(text, '## Worker lifecycle');
    expect(worker).toContain('pre-flight');
    expect(worker).not.toContain('Completion authority');
  });

  it('rejects unresolved, ambiguous, oversized, and missing referenced inputs', () => {
    const text = '# Doc\n\n## Same\n\nA\n\n## Same\n\nB\n';
    expect(() => extractSection(text, '## Missing')).toThrow(/ops_wiki_unresolved_selector/u);
    expect(() => extractSection(text, '## Same')).toThrow(/ops_wiki_ambiguous_selector/u);

    const oversized = initRepo(fixtureFiles('x'.repeat(13000)));
    expect(() => planEpisodes(oversized.repoRoot, oversized.commit, fixtureManifest())).toThrow(/ops_wiki_episode_over_byte_ceiling/u);

    const missing = initRepo(fixtureFiles());
    writeManifestAndGolden(missing.repoRoot, fixtureManifest({
      episodes: [
        { ...fixtureManifest().episodes[0]!, referenced_paths: ['scripts/missing-smoke.ts'] },
        fixtureManifest().episodes[1]!,
      ],
    }));
    expect(() => checkRepositoryMode({ repoRoot: missing.repoRoot, commitRef: 'HEAD' })).toThrow(/ops_wiki_missing_referenced_path/u);
  });

  it('records derived provenance and a semantic generation hash', () => {
    const { repoRoot } = initRepo(fixtureFiles());
    const head = writeManifestAndGolden(repoRoot);
    const [episode] = planEpisodes(repoRoot, head, fixtureManifest());
    expect(episode!.markdown).toContain(`source_commit: "${head}"`);
    expect(episode!.sourceHash).toBe(sha256(readFileSync(join(repoRoot, 'docs/runbook.md'), 'utf8')));
    expect(episode!.extractionHash).toHaveLength(64);
    expect(episode!.generationHash).toHaveLength(64);
    expect(episode!.markdown).toContain(`generation_hash: "${episode!.generationHash}"`);
  });

  it('loads manifest and golden control inputs from the resolved commit, not dirty files', async () => {
    const { repoRoot } = initRepo(fixtureFiles('committed worker text\n'));
    const commit = writeManifestAndGolden(repoRoot);
    write(repoRoot, OPS_WIKI_MANIFEST_RELATIVE, '{dirty-invalid-json');
    write(repoRoot, OPS_WIKI_GOLDEN_RELATIVE, '{dirty-invalid-json');
    write(repoRoot, 'docs/runbook.md', readFileSync(join(repoRoot, 'docs/runbook.md'), 'utf8').replace('committed worker text', 'dirty worker text'));

    const checked = checkRepositoryMode({ repoRoot, commitRef: commit });
    expect(checked).toMatchObject({ ok: true, commit });

    const corpusRoot = tempDir('ops-wiki-corpus-');
    const result = await applyFixture(repoRoot, corpusRoot, commit);
    expect(result).toMatchObject({ ok: true, commit });
    const note = readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8');
    expect(note).toContain('committed worker text');
    expect(note).not.toContain('dirty worker text');
  });

  it('rejects manifest path escape and Synto-vault targets before mutation', async () => {
    expect(() => loadManifest(JSON.stringify({
      ...fixtureManifest(),
      episodes: [{ ...fixtureManifest().episodes[0], path: '../secret.md' }],
    }))).toThrow(/ops_wiki_path_escape/u);

    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const synto = tempDir('synto-vault-');
    await expect(applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot: synto,
      syntoVault: synto,
      client: corpusClient(synto),
    })).resolves.toMatchObject({ ok: false, mutationBegan: false, reason: expect.stringContaining('ops_wiki_synto_vault_rejected') });
  });

  it('rejects asymmetric related edges and accepts symmetric ones', () => {
    const manifest = fixtureManifest();
    expect(loadManifest(JSON.stringify(manifest)).episodes).toHaveLength(2);
    const asymmetric = {
      ...manifest,
      episodes: manifest.episodes.map((episode) => episode.episode_id === 'agents-boundaries'
        ? { ...episode, edges: [] }
        : episode),
    };
    expect(() => loadManifest(JSON.stringify(asymmetric))).toThrow(
      'ops_wiki_manifest_malformed:asymmetric_related:worker-lifecycle:agents-boundaries',
    );
  });
});

describe('ops-wiki apply protocol', () => {
  it('publishes and confirms apply_in_progress before episode mutation', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const seen: boolean[] = [];
    const base = corpusClient(corpusRoot);
    const client: WikiOpsClient = {
      ...base,
      async read(path, options) {
        if (path === OPS_WIKI_STATUS_NOTE) seen.push(existsSync(join(corpusRoot, episodeRelativePath('worker-lifecycle'))));
        return base.read(path, options);
      },
    };
    const result = await applyFixture(repoRoot, corpusRoot, 'HEAD', client);
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe(false);
    const status = parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8'));
    expect(status.checkedThrough).toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim());
    expect(status.applyInProgress).toBeUndefined();
  });

  it('restores the prior clean state when in-progress cannot be index-confirmed before mutation', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const failed = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client: corpusClient(corpusRoot, { timeout: true }),
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 10,
      pollIntervalMs: 1,
    });
    expect(failed).toMatchObject({ ok: false, mutationBegan: false });
    expect(existsSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE))).toBe(false);
    expect(existsSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')))).toBe(false);
  });

  it('requires the indexed in-progress fence to preserve exact prior checked-through absence', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    const target = writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const base = corpusClient(corpusRoot);
    const client: WikiOpsClient = {
      ...base,
      async read(path, options) {
        if (path === OPS_WIKI_STATUS_NOTE) {
          return {
            ok: true,
            path,
            content: renderStatusNote({ checkedThrough: 'f'.repeat(40), applyInProgress: target }),
          };
        }
        return base.read(path, options);
      },
    };
    const failed = await applyOpsWiki({
      repoRoot,
      commitRef: target,
      corpusRoot,
      client,
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 10,
      pollIntervalMs: 1,
    });
    expect(failed).toMatchObject({ ok: false, mutationBegan: false });
    expect(existsSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE))).toBe(false);
    expect(existsSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')))).toBe(false);
  });

  it('is no-op for an already checked commit and status-only for an irrelevant descendant', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    expect(await applyFixture(repoRoot, corpusRoot)).toMatchObject({ ok: true, status: 'applied' });
    expect(await applyFixture(repoRoot, corpusRoot)).toMatchObject({ ok: true, status: 'no_op' });

    write(repoRoot, 'UNRELATED.md', 'not a declared source\n');
    git(repoRoot, ['add', 'UNRELATED.md']);
    git(repoRoot, ['commit', '-m', 'unrelated']);
    const later = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const result = await applyFixture(repoRoot, corpusRoot, later);
    expect(result).toMatchObject({ ok: true, status: 'status_only', commit: later });
  });

  it('rewrites retained episodes when manifest-owned metadata changes without body changes', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    expect(await applyFixture(repoRoot, corpusRoot)).toMatchObject({ ok: true, status: 'applied' });

    const updated = fixtureManifest({
      episodes: [
        { ...fixtureManifest().episodes[0]!, aliases: ['pre-flight', 'воркер', 'new-alias'] },
        fixtureManifest().episodes[1]!,
      ],
    });
    writeManifestAndGolden(repoRoot, updated);
    const result = await applyFixture(repoRoot, corpusRoot);
    expect(result).toMatchObject({ ok: true, status: 'applied' });
    expect(result.ok && result.changedEpisodeIds).toContain('worker-lifecycle');
    expect(readFileSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')), 'utf8')).toContain('new-alias');
  });

  it('deletes only obsolete owned notes and preserves foreign files and root dotfiles', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    await applyFixture(repoRoot, corpusRoot);
    write(corpusRoot, 'foreign.md', 'leave me\n');
    write(corpusRoot, '.obsidian-hybrid-search.db', 'db');
    write(corpusRoot, '.obsidian-hybrid-search.db-wal', 'wal');

    const remaining = { ...fixtureManifest().episodes[1]!, edges: [] };
    writeManifestAndGolden(repoRoot, fixtureManifest({ episodes: [remaining] }), ['agents-boundaries']);
    const result = await applyFixture(repoRoot, corpusRoot);
    expect(result.ok && result.removedEpisodeIds).toContain('worker-lifecycle');
    expect(existsSync(join(corpusRoot, episodeRelativePath('worker-lifecycle')))).toBe(false);
    expect(readFileSync(join(corpusRoot, 'foreign.md'), 'utf8')).toBe('leave me\n');
    expect(readFileSync(join(corpusRoot, '.obsidian-hybrid-search.db'), 'utf8')).toBe('db');
  });

  it('keeps the in-progress fence when final index status read-back fails after mutation', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    expect(await applyFixture(repoRoot, corpusRoot)).toMatchObject({ ok: true });
    const previous = git(repoRoot, ['rev-parse', 'HEAD']).trim();

    write(repoRoot, 'docs/runbook.md', readFileSync(join(repoRoot, 'docs/runbook.md'), 'utf8').replace('pre-flight', 'strict pre-flight'));
    git(repoRoot, ['add', 'docs/runbook.md']);
    git(repoRoot, ['commit', '-m', 'relevant']);
    const target = git(repoRoot, ['rev-parse', 'HEAD']).trim();

    const base = corpusClient(corpusRoot);
    const client: WikiOpsClient = {
      ...base,
      async read(path, options) {
        if (path === OPS_WIKI_STATUS_NOTE && existsSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE))) {
          const local = parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8'));
          if (local.checkedThrough === target && !local.applyInProgress) return { ok: false, reason: 'timeout' };
        }
        return base.read(path, options);
      },
    };

    const result = await applyOpsWiki({
      repoRoot,
      commitRef: target,
      corpusRoot,
      client,
      git: recordingGit(repoRoot, corpusRoot).git,
      convergenceTimeoutMs: 10,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ ok: false, mutationBegan: true, checkedThrough: previous, applyInProgress: target });
    expect(parseStatusNote(readFileSync(join(corpusRoot, OPS_WIKI_STATUS_NOTE), 'utf8'))).toEqual({
      checkedThrough: previous,
      applyInProgress: target,
    });
  });

  it('requires every expected golden episode to appear in the top three', async () => {
    const suite = loadGoldenSuite(JSON.stringify({
      queries: [{ id: 'multi', query: 'worker', expected_episode_ids: ['worker-lifecycle', 'agents-boundaries'] }],
    }));
    const client: WikiOpsClient = {
      async read() { return { ok: false, reason: 'absent' }; },
      async search() { return [{ path: episodeRelativePath('worker-lifecycle'), score: 0.9 }]; },
    };
    await expect(runGoldenSuite(client, suite)).resolves.toEqual({ ok: false, reason: 'golden_miss:multi' });
  });

  it('uses no Git command in the corpus and supports explicit existing reindex only', async () => {
    const { repoRoot } = initRepo(fixtureFiles());
    writeManifestAndGolden(repoRoot);
    const corpusRoot = tempDir('ops-wiki-corpus-');
    const { git: gitRunner, cwds } = recordingGit(repoRoot, corpusRoot);
    let reindexed = 0;
    const base = corpusClient(corpusRoot);
    const client: WikiOpsClient = {
      ...base,
      async reindex() { reindexed += 1; },
    };
    const result = await applyOpsWiki({
      repoRoot,
      commitRef: 'HEAD',
      corpusRoot,
      client,
      git: gitRunner,
      reindex: 'full',
      convergenceTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(reindexed).toBe(1);
    expect(cwds.every((cwd) => cwd === repoRoot)).toBe(true);
    expect(existsSync(join(corpusRoot, '.git'))).toBe(false);
  });
});

describe('ops-wiki routing policy', () => {
  const policy = { weak_top1_score: 0.5, ambiguity_max_score_delta: 0.05 };
  const commit = 'a'.repeat(40);
  const status = (body: string): WikiOpsReadResult => ({ ok: true, path: OPS_WIKI_STATUS_NOTE, content: body });

  it('uses wiki-ops only for exact current-clean status', () => {
    const clean = renderStatusNote({ checkedThrough: commit });
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: status(clean) })).toBe('use_wiki_ops');
    expect(evaluateOperationalFreshness({ currentCommit: 'b'.repeat(40), read: status(clean) })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({
      currentCommit: commit,
      read: status(renderStatusNote({ checkedThrough: commit, applyInProgress: 'b'.repeat(40) })),
    })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: false, reason: 'timeout' } })).toBe('canonical_files');
    expect(evaluateOperationalFreshness({ currentCommit: commit, read: { ok: true, path: OPS_WIKI_STATUS_NOTE, content: 'bad' } })).toBe('canonical_files');
  });

  it('parses the body-only MCP read fixture and rejects conflicting status metadata', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/ops-wiki-read-body.json'), 'utf8')) as { results: Array<{ path: string; content: string }> };
    const statusRead = fixture.results.find((result) => result.path === OPS_WIKI_STATUS_NOTE);
    expect(statusRead).toBeDefined();
    expect(parseStatusNote(statusRead!.content)).toEqual({ checkedThrough: 'a'.repeat(40), applyInProgress: undefined });
    expect(evaluateOperationalFreshness({ currentCommit: 'a'.repeat(40), read: { ok: true, path: statusRead!.path, content: statusRead!.content } })).toBe('use_wiki_ops');
    const conflicting = renderStatusNote({ checkedThrough: 'a'.repeat(40) }).replace(`{"checked_through_commit":"${'a'.repeat(40)}"}`, `{"checked_through_commit":"${'b'.repeat(40)}"}`);
    expect(() => parseStatusNote(conflicting)).toThrow('ops_wiki_status_malformed');
  });

  it('escalates absent, weak, ambiguous, and invalid episode reads', () => {
    expect(evaluateSearchEscalation([], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md' }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.4 }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.51 }, { path: 'episodes/b.md', score: 0.5 }], policy)).toBe('expand');
    expect(evaluateSearchEscalation([{ path: 'episodes/a.md', score: 0.9 }, { path: 'episodes/b.md', score: 0.4 }], policy)).toBe('read_top1');

    const episode: RenderedEpisode = {
      episode_id: 'worker-lifecycle',
      relativePath: episodeRelativePath('worker-lifecycle'),
      title: 'Worker lifecycle',
      markdown: 'x',
      body: 'x',
      sourcePath: 'docs/runbook.md',
      sourceSections: ['## Worker lifecycle'],
      sourceHash: 'h',
      extractionHash: 'h',
      generationHash: 'g'.repeat(64),
      aliases: [],
      edges: [],
      referencedPaths: [],
    };
    expect(evaluateEpisodeRead({ read: { ok: false, reason: 'absent' }, episode })).toBe('expand');
    expect(evaluateEpisodeRead({
      read: {
        ok: true,
        path: episode.relativePath,
        content: `\n# Worker lifecycle\n`,
      },
      episode,
    })).toBe('expand');
    expect(evaluateEpisodeRead({
      read: {
        ok: true,
        path: episode.relativePath,
        content: `\n\`\`\`ops-wiki-episode\n{"episode_id":"worker-lifecycle","source_commit":"bad","generation_hash":"wrong"}\n\`\`\`\n\n## Worker lifecycle\n`,
      },
      episode,
    })).toBe('expand');
    expect(evaluateEpisodeRead({
      read: {
        ok: true,
        path: episode.relativePath,
        content: `\n\`\`\`ops-wiki-episode\n{"episode_id":"worker-lifecycle","source_commit":"${commit}","generation_hash":"${episode.generationHash}"}\n\`\`\`\n\n## Worker lifecycle\n`,
      },
      episode,
    })).toBe('read_top1');
  });

  it('builds 2-4 distinct RU/EN escalation queries', () => {
    const queries = buildEscalationQueries('что воркер должен сделать');
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('ops-wiki production MCP seam', () => {
  it('uses the stateless Streamable HTTP contract and parses real read {results:[...]} payloads', async () => {
    const calls: string[] = [];
    const client = createMcpWikiOpsClient('http://wiki-ops.test/mcp', async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number; params?: { name?: string } };
      calls.push(body.method);
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
        : {
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [{
                path: OPS_WIKI_STATUS_NOTE,
                found: true,
                content: renderStatusNote({ checkedThrough: 'c'.repeat(40) }),
              }],
            }),
          }],
        };
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const read = await client.read(OPS_WIKI_STATUS_NOTE, { related: false });
    expect(read).toMatchObject({ ok: true, path: OPS_WIKI_STATUS_NOTE });
    expect(calls).toEqual(['initialize', 'tools/call']);
  });

  it('bounds a non-returning production request', async () => {
    const client = createMcpWikiOpsClient('http://wiki-ops.test/mcp', async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true });
      });
    }, 5);
    const started = Date.now();
    const read = await client.read(OPS_WIKI_STATUS_NOTE, { related: false });
    expect(read).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
