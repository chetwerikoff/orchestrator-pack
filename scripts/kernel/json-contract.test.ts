import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../fleet-liveness.cases.ts';
import '../fleet-liveness-census.cases.ts';
import '../review-ready-seed-liveness.test.ts';
import {
  parseCaptureManifest,
  parseDaemonStatusCapture,
  type CaptureManifest,
  type DaemonStatusCapture,
} from '#opk-kernel/artifact-contracts';
import { JsonContractError } from '#opk-kernel/json-contract';

const repoRoot = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(repoRoot, 'tests/external-output-references/capture-manifest.json');
const capturePath = resolve(
  repoRoot,
  'tests/external-output-references/captures/ao-0-10-cli/daemon-status.raw.json',
);

function expectContractPath(action: () => unknown, path: string): void {
  try {
    action();
    throw new Error('expected JSON contract validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(JsonContractError);
    expect((error as JsonContractError).issues[0]?.path).toBe(path);
  }
}

describe('JSON contract kernel', () => {
  it('round-trips the real capture manifest byte-for-byte', () => {
    const source = readFileSync(manifestPath);
    const document = parseCaptureManifest(source);
    expect(Buffer.from(document.serializeUnchanged()).equals(source)).toBe(true);
    expect(document.value.corpusRoot).toBe('tests/external-output-references');
  });

  it('round-trips the real daemon-status capture byte-for-byte', () => {
    const source = readFileSync(capturePath);
    const document = parseDaemonStatusCapture(source);
    expect(Buffer.from(document.serializeUnchanged()).equals(source)).toBe(true);
    expect(document.value.state).toBe('ready');
  });

  it('preserves key order and trailing-newline parity on the unchanged path', () => {
    const source = readFileSync(capturePath);
    const roundTrip = Buffer.from(parseDaemonStatusCapture(source).serializeUnchanged());
    expect(roundTrip.at(-1)).toBe(source.at(-1));
    expect(roundTrip.toString('utf8').indexOf('"state"')).toBeLessThan(
      roundTrip.toString('utf8').indexOf('"pid"'),
    );
    expect(roundTrip.equals(source)).toBe(true);
  });

  it('reports a precise path for drifted required data', () => {
    const value = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
    value.pid = 'not-a-number';
    expectContractPath(() => parseDaemonStatusCapture(JSON.stringify(value)), '$.pid');
  });

  it('reports a precise path for drifted capture-manifest data', () => {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Record<string, Record<string, unknown>>;
    };
    const firstKey = Object.keys(value.entries)[0];
    const firstEntry = firstKey ? value.entries[firstKey] : undefined;
    if (!firstKey || !firstEntry) throw new Error('capture manifest has no entries');
    firstEntry.kind = 'binary';
    expectContractPath(
      () => parseCaptureManifest(JSON.stringify(value)),
      `$.entries[${JSON.stringify(firstKey)}].kind`,
    );
  });

  it('rejects an unexpected nested capture-manifest key with its precise path', () => {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Record<string, Record<string, unknown>>;
    };
    const firstKey = Object.keys(value.entries)[0];
    expect(firstKey).toBeDefined();
    const firstEntry = firstKey ? value.entries[firstKey] : undefined;
    if (!firstEntry) throw new Error('capture manifest has no entries');
    firstEntry.unexpected = true;
    expectContractPath(
      () => parseCaptureManifest(JSON.stringify(value)),
      `$.entries[${JSON.stringify(firstKey)}].unexpected`,
    );
  });

  it('rejects an unexpected nested daemon-status key with its precise path', () => {
    const value = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
    value.unexpected = true;
    expectContractPath(() => parseDaemonStatusCapture(JSON.stringify(value)), '$.unexpected');
  });

  it('keeps modified serialization explicit, deterministic, and distinct', () => {
    const source = readFileSync(capturePath);
    const document = parseDaemonStatusCapture(source);
    const modified: DaemonStatusCapture = { ...document.value, state: 'stopped' };
    const first = Buffer.from(document.serializeModified(modified));
    const second = Buffer.from(document.serializeModified(modified));
    expect(first.equals(second)).toBe(true);
    expect(first.equals(source)).toBe(false);
    expect(JSON.parse(first.toString('utf8'))).toMatchObject({ state: 'stopped' });
  });

  it('freezes validated values so mutation cannot masquerade as an unchanged round trip', () => {
    const document = parseCaptureManifest(readFileSync(manifestPath));
    expect(Object.isFrozen(document.value)).toBe(true);
    expect(Object.isFrozen(document.value.entries)).toBe(true);
    expect(() => {
      (document.value as CaptureManifest & { version: number }).version = 2;
    }).toThrow();
  });
});
