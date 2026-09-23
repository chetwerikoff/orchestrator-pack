// @vitest-ci-lane light
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyReconciliationTransport } from './lib/create-issue-stage-record-artifacts.ts';
import {
  COVERED_REPLAY_FIXTURE_INVENTORY,
  importReplayFixture,
  runReplayFixturePolicyCheck,
  scanReplayFixtureSensitivePatterns,
  scrubReplayFixtureBytes,
  selectJsonlRecordBytes,
  sha256ReplayFixtureBytes,
} from './replay-fixture-import.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opk-replay-fixture-'));
  tempDirs.push(dir);
  return dir;
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syntheticSidecar(bytes: Buffer, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    synthetic: true,
    scrub_rules: [],
    scrubbed_sha256: sha(bytes),
    ...overrides,
  }, null, 2)}\n`;
}

function makeCoveredRepo(): string {
  const root = tempDir();
  const dir = join(root, 'tests/external-output-references');
  mkdirSync(dir, { recursive: true });
  for (const relative of COVERED_REPLAY_FIXTURE_INVENTORY) {
    const bytes = Buffer.from(`safe fixture ${relative}\n`);
    const absolute = join(root, relative);
    writeFileSync(absolute, bytes);
    writeFileSync(`${absolute}.provenance.json`, syntheticSidecar(bytes));
  }
  return root;
}

describe('replay fixture scrubber', () => {
  it.each([
    ['raw ChatGPT URL', 'before https://chatgpt.com/c/abc?x=1 after', 'before <chatgpt-url> after'],
    ['escaped ChatGPT URL', 'before https:\\/\\/chatgpt.com\\/c\\/abc?x=1 after', 'before <chatgpt-url> after'],
    ['ghp token', `x ghp_${'a'.repeat(20)}!`, 'x <redacted-token>!'],
    ['gho token', `x gho_${'b'.repeat(20)}.`, 'x <redacted-token>.'],
    ['ghu token', `x ghu_${'c'.repeat(20)}/`, 'x <redacted-token>/'],
    ['ghs token', `x ghs_${'d'.repeat(20)}:`, 'x <redacted-token>:'],
    ['ghr token', `x ghr_${'e'.repeat(20)}]`, 'x <redacted-token>]'],
    ['github_pat token', `x github_pat_${'f'.repeat(20)};`, 'x <redacted-token>;'],
    ['sk token', `x sk-${'g-h_'.repeat(5)}!`, 'x <redacted-token>!'],
    ['linux home', 'x=/home/alice/project', 'x=<home>/project'],
    ['mac home', 'x:/Users/alice/project', 'x:<home>/project'],
    ['escaped linux home', 'x="\\/home\\/alice\\/project"', 'x="<home>\\/project"'],
    ['escaped mac home', 'x="\\/Users\\/alice\\/project"', 'x="<home>\\/project"'],
    ['windows home', 'x=C:\\Users\\alice\\project', 'x=<home>\\project'],
    ['escaped windows home', 'x="C:\\\\Users\\\\alice\\\\project"', 'x="<home>\\\\project"'],
  ])('scrubs %s deterministically', (_name, input, expected) => {
    expect(scrubReplayFixtureBytes(Buffer.from(input)).bytes.toString()).toBe(expected);
  });

  it.each([
    'task-foo',
    'github_patience',
    'sk-short',
    `ask-${'x'.repeat(20)}`,
    `prefixAghp_${'x'.repeat(20)}`,
    '/home/alice@example',
    'prefix/Users/alice/path',
  ])('keeps negative input byte-identical: %s', (input) => {
    const bytes = Buffer.from(input);
    const result = scrubReplayFixtureBytes(bytes);
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.scrubRules).toEqual([]);
  });

  it('stops tokens exactly at the first byte outside their body charset', () => {
    const input = Buffer.from(`ghp_${'a'.repeat(20)}-tail sk-${'b'.repeat(20)}.tail`);
    expect(scrubReplayFixtureBytes(input).bytes.toString()).toBe(`<redacted-token>-tail <redacted-token>.tail`);
  });

  it('reports only the forbidden rule ids and never needs an entropy scanner', () => {
    const bytes = Buffer.from(`https://chatgpt.com/c/a ghp_${'a'.repeat(20)} /home/alice/x`);
    expect([...new Set(scanReplayFixtureSensitivePatterns(bytes).map((match) => match.rule))]).toEqual([
      'chatgpt-url',
      'token-like',
      'home-root',
    ]);
  });
});

describe('replay fixture importer', () => {
  it('imports whole-file bytes through the same scrub path and writes bound provenance', () => {
    const dir = tempDir();
    const input = join(dir, 'raw.txt');
    const output = join(dir, 'fixture.txt');
    const raw = Buffer.from(`url=https://chatgpt.com/c/abc\npath=/home/alice/x\n`);
    writeFileSync(input, raw);

    const result = importReplayFixture({
      inputPath: input,
      outputPath: output,
      sourceKind: 'browser-turn-recurrence',
      issue: 2005,
      stage: 'implementation',
      slot: 'operator-local',
      capturedAt: '2026-09-23',
    });
    const fixture = readFileSync(output);
    const sidecar = JSON.parse(readFileSync(`${output}.provenance.json`, 'utf8')) as Record<string, unknown>;
    expect(fixture.toString()).toBe('url=<chatgpt-url>\npath=<home>/x\n');
    expect(result.sourceSha256).toBe(sha(raw));
    expect(result.scrubbedSha256).toBe(sha(fixture));
    expect(sidecar.source_sha256).toBe(sha(raw));
    expect(sidecar.scrubbed_sha256).toBe(sha(fixture));
    expect(sidecar.scrub_rules).toEqual(['chatgpt-url', 'home-root']);
    expect(sidecar.synthetic).toBe(false);
  });

  it('selects one 1-based JSONL record before the same scrub path and hashes only selected bytes', () => {
    const dir = tempDir();
    const input = join(dir, 'raw.jsonl');
    const output = join(dir, 'fixture.json');
    const second = Buffer.from(`{"url":"https:\\/\\/chatgpt.com\\/c\\/abc"}`);
    writeFileSync(input, Buffer.concat([Buffer.from('{"n":1}\r\n'), second, Buffer.from('\n{"n":3}\n')]));

    const selected = selectJsonlRecordBytes(readFileSync(input), 2);
    expect(selected.equals(second)).toBe(true);
    const result = importReplayFixture({
      inputPath: input,
      outputPath: output,
      sourceKind: 'producer-jsonl',
      issue: 2005,
      stage: 'implementation',
      slot: 'record-2',
      capturedAt: '2026-09-23',
      jsonlRecord: 2,
    });
    expect(result.sourceSha256).toBe(sha(second));
    expect(readFileSync(output, 'utf8')).toBe('{"url":"<chatgpt-url>"}');
  });

  it('rejects invalid JSONL record indexes', () => {
    expect(() => selectJsonlRecordBytes(Buffer.from('one\n'), 0)).toThrow(/positive 1-based/u);
    expect(() => selectJsonlRecordBytes(Buffer.from('one\n'), 2)).toThrow(/outside/u);
    expect(() => selectJsonlRecordBytes(Buffer.from('one\n'), 3)).toThrow(/outside/u);
  });
});

describe('replay fixture policy guard', () => {
  it('accepts exactly the closed two-path inventory with matching explicit synthetic sidecars', () => {
    const root = makeCoveredRepo();
    expect(runReplayFixturePolicyCheck(root)).toMatchObject({ ok: true, failures: [] });
  });

  it('fails a missing sidecar, a forbidden value, and stale scrubbed_sha256', () => {
    const root = makeCoveredRepo();
    const first = join(root, COVERED_REPLAY_FIXTURE_INVENTORY[0]);
    rmSync(`${first}.provenance.json`);
    let result = runReplayFixturePolicyCheck(root);
    expect(result.failures.join('\n')).toMatch(/missing provenance sidecar/u);

    const bytes = Buffer.from(`ghp_${'x'.repeat(20)}\n`);
    writeFileSync(first, bytes);
    writeFileSync(`${first}.provenance.json`, syntheticSidecar(bytes, { scrubbed_sha256: '0'.repeat(64) }));
    result = runReplayFixturePolicyCheck(root);
    expect(result.failures.join('\n')).toMatch(/forbidden sensitive pattern/u);
    expect(result.failures.join('\n')).toMatch(/does not match current fixture bytes/u);
  });

  it('reports a newly matching covered filename as scope drift rather than accepting it', () => {
    const root = makeCoveredRepo();
    const extra = join(root, 'tests/external-output-references/flow-manager-long-child-new.json');
    writeFileSync(extra, Buffer.from('safe\n'));
    expect(runReplayFixturePolicyCheck(root).failures.join('\n')).toMatch(/scope drift/u);
  });

  it('rejects invented raw-source provenance on explicit synthetic fixtures', () => {
    const root = makeCoveredRepo();
    const first = join(root, COVERED_REPLAY_FIXTURE_INVENTORY[0]);
    const bytes = readFileSync(first);
    writeFileSync(`${first}.provenance.json`, syntheticSidecar(bytes, { source_sha256: 'a'.repeat(64) }));
    expect(runReplayFixturePolicyCheck(root).failures.join('\n')).toMatch(/must not invent raw-source provenance/u);
  });

  it('requires harvested provenance when synthetic is false and allows only the historical-backfill null form', () => {
    const root = makeCoveredRepo();
    const first = join(root, COVERED_REPLAY_FIXTURE_INVENTORY[0]);
    const bytes = readFileSync(first);
    writeFileSync(`${first}.provenance.json`, `${JSON.stringify({
      synthetic: false,
      scrub_rules: [],
      scrubbed_sha256: sha256ReplayFixtureBytes(bytes),
      source_kind: 'historical',
      issue: 1978,
      stage: 'author-disposition',
      slot: 'author',
      captured_at: '2026-09-21',
      source_sha256: null,
      source_unavailable: 'historical-backfill',
    }, null, 2)}\n`);
    expect(runReplayFixturePolicyCheck(root).ok).toBe(true);

    writeFileSync(`${first}.provenance.json`, syntheticSidecar(bytes, { synthetic: false }));
    expect(runReplayFixturePolicyCheck(root).failures.join('\n')).toMatch(/harvested provenance requires/u);
  });
});

describe('committed transport-shape regression', () => {
  it('keeps the committed Issue #926 terminal fixture valid after passing through the same scrubber', () => {
    const path = resolve(import.meta.dirname, '..', 'tests/external-output-references/create-issue-926-terminal-competitive-01-final.json');
    const scrubbed = scrubReplayFixtureBytes(readFileSync(path));
    expect(scrubbed.scrubRules).toEqual([]);
    const envelope = JSON.parse(scrubbed.bytes.toString('utf8')) as Record<string, unknown>;
    expect(classifyReconciliationTransport(envelope, 1)).toMatchObject({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'retry-forbidden',
    });
  });
});

describe('operator-local AC2 evidence', () => {
  const source = process.env.OPK_ISSUE_2005_AC2_SOURCE ?? resolve(process.env.HOME ?? '', '.local/state/create-issue-draft/.review/926/terminal-competitive-01-final.json');

  it.skipIf(!existsSync(source))('imports the exact Issue #926 source and preserves its classified transport shape', () => {
    const output = join(tempDir(), 'terminal-competitive-01-final.json');
    const result = importReplayFixture({
      inputPath: source,
      outputPath: output,
      sourceKind: 'browser-turn-recurrence',
      issue: 2005,
      stage: 'ac2-operator-local-evidence',
      slot: 'source-artifact',
      capturedAt: '2026-09-23T00:00:00.000Z',
    });
    const fixture = readFileSync(output);
    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf8')) as Record<string, unknown>;

    expect(result.sourceSha256).toBe('a318c3c17cd876ba4316984498f627e8de0af7b25a8293995ee963d362141124');
    expect(result.scrubbedSha256).toBe('b245faac177a09a0328703e91c9f31e1ca110d23471d27521cced9e684433095');
    expect(result.scrubRules).toEqual(['home-root']);
    expect(scanReplayFixtureSensitivePatterns(fixture)).toEqual([]);
    expect(sidecar).toMatchObject({
      source_kind: 'browser-turn-recurrence',
      issue: 2005,
      stage: 'ac2-operator-local-evidence',
      slot: 'source-artifact',
      source_sha256: result.sourceSha256,
      scrubbed_sha256: sha256ReplayFixtureBytes(fixture),
      scrub_rules: ['home-root'],
      synthetic: false,
    });
    expect(classifyReconciliationTransport(JSON.parse(fixture.toString('utf8')) as Record<string, unknown>, 1)).toMatchObject({
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'eligible-zero-send',
    });
  });
});
