import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { InventoryRow } from '../docs/launch-argv-registry.mjs';
import {
  auditLaunchArgvInventory,
  classifyDiscoveryHits,
  discoverLaunchSites,
  hashNormalizedBody,
  isTestExcludedFile,
  loadLaunchArgvBundle,
  matchDiscoveryHit,
  validateInventoryRows,
} from '../docs/launch-argv-registry.mjs';

const repoRoot = join(import.meta.dirname, '..');
const guardScript = join(repoRoot, 'scripts/check-launch-argv-inventory.ps1');
const fixtureRoot = join(repoRoot, 'scripts/fixtures/launch-argv-inventory');
const pwshTimeoutMs = 120_000;

function runGuard(args: string[] = []) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: pwshTimeoutMs,
  });
}

function writeJson(dir: string, rel: string, value: unknown) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('launch-argv inventory (#661)', { timeout: pwshTimeoutMs }, () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes audit on the real repository tree', () => {
    const result = auditLaunchArgvInventory(repoRoot);
    expect(result.verdict, result.violations.join('\n')).toBe('PASS');
    expect(result.stats.productionHits).toBeGreaterThan(0);
    expect(result.stats.inventoryRows).toBeGreaterThan(0);
  });

  it('guard script passes on the real repository tree', () => {
    const result = runGuard();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/PASS.*launch-argv inventory guard/i);
  });

  it('fails discovery when a production launch site is unregistered', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'launch-argv-unreg-'));
    tempDirs.push(tmp);
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    copyFileSync(join(repoRoot, 'scripts/launch-argv-validators.manifest.json'), join(tmp, 'scripts/launch-argv-validators.manifest.json'));
    copyFileSync(join(repoRoot, 'scripts/launch-argv-test-exclusions.manifest.json'), join(tmp, 'scripts/launch-argv-test-exclusions.manifest.json'));
    writeJson(tmp, 'scripts/launch-argv-inventory.json', {
      schemaVersion: 1,
      absorbedCoverage: [],
      hashPinnedAllowlist: [],
      rows: [],
    });
    writeFileSync(
      join(tmp, 'scripts/new-unregistered-launch.ts'),
      "import { spawnSync } from 'node:child_process';\nexport function go() { return spawnSync('node', ['-e', 'process.exit(0)']); }\n",
      'utf8',
    );

    const hits = discoverLaunchSites(tmp, {
      files: ['scripts/new-unregistered-launch.ts'],
      testExclusions: JSON.parse(readFileSync(join(tmp, 'scripts/launch-argv-test-exclusions.manifest.json'), 'utf8')),
    });
    const production = hits.filter((h: { classification: string }) => h.classification === 'production');
    expect(production.length).toBeGreaterThan(0);
    const { failures } = classifyDiscoveryHits(hits, [], []);
    expect(failures.some((f: string) => f.includes('unmapped production launch site'))).toBe(true);
  });

  it('passes once the unregistered site is inventoried', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'launch-argv-reg-'));
    tempDirs.push(tmp);
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    copyFileSync(join(repoRoot, 'scripts/launch-argv-validators.manifest.json'), join(tmp, 'scripts/launch-argv-validators.manifest.json'));
    copyFileSync(join(repoRoot, 'scripts/launch-argv-test-exclusions.manifest.json'), join(tmp, 'scripts/launch-argv-test-exclusions.manifest.json'));
    const rel = 'scripts/new-unregistered-launch.ts';
    writeFileSync(
      join(tmp, rel),
      "import { spawnSync } from 'node:child_process';\nexport function go() { return spawnSync('node', ['-e', 'process.exit(0)']); }\n",
      'utf8',
    );
    writeJson(tmp, 'scripts/launch-argv-inventory.json', {
      schemaVersion: 1,
      absorbedCoverage: [],
      hashPinnedAllowlist: [],
      rows: [
        {
          rowId: 'fixture-unregistered-site',
          caller: { file: rel, line: 2 },
          callee: { kind: 'other-external', identity: 'node -e' },
          calleeContractSourceClass: 'allowlist-only',
          coverageKind: 'allowlist-debt',
          allowlistDebt: { reason: 'fixture allowlist', followUpOwner: 'fixture' },
          discoveryMatch: { file: rel, line: 2, patternIds: ['spawnSync', 'node-child'] },
        },
      ],
    });

    const hits = discoverLaunchSites(tmp, {
      files: [rel],
      testExclusions: JSON.parse(readFileSync(join(tmp, 'scripts/launch-argv-test-exclusions.manifest.json'), 'utf8')),
    });
    const bundle = loadLaunchArgvBundle(tmp);
    const { failures } = classifyDiscoveryHits(hits, bundle.inventory.rows, []);
    expect(failures).toEqual([]);
  });

  it('excludes test-only spawn sites explicitly', () => {
    const bundle = loadLaunchArgvBundle(repoRoot);
    expect(isTestExcludedFile('scripts/foo.test.ts', bundle.testExclusions)).toBe(true);
    expect(isTestExcludedFile('scripts/lib/Worker-Recovery.ps1', bundle.testExclusions)).toBe(false);
  });

  it('rejects invalid validator ids in inventory rows', () => {
    const bundle = loadLaunchArgvBundle(repoRoot);
    const broken = {
      ...bundle,
      inventory: {
        ...bundle.inventory,
        rows: [
          ...bundle.inventory.rows,
          {
            rowId: 'bad-validator-id-row',
            caller: { file: 'scripts/verify.ps1', line: 1 },
            callee: { kind: 'pack-ps1', identity: 'x' },
            calleeContractSourceClass: 'allowlist-only',
            coverageKind: 'validator-backed',
            validatorId: 'nonexistent-validator',
          } satisfies InventoryRow,
        ],
      },
    };
    const violations = validateInventoryRows(broken, repoRoot);
    expect(violations.some((v: string) => v.includes('unknown validatorId'))).toBe(true);
  });

  it('references each shipped validator in inventory rows', () => {
    const bundle = loadLaunchArgvBundle(repoRoot);
    const required = [
      'side-process-launch-contract',
      'ao-spawn-shape',
      'ao-cli-argv-shape',
      'ao-dead-argv-bypass',
      'gh-inventory-static',
    ];
    for (const id of required) {
      const referenced = bundle.inventory.rows.some((row: { validatorId?: string }) => row.validatorId === id);
      const absorbed = (bundle.inventory.absorbedCoverage ?? []).some(
        (rec: { validatorId: string }) => rec.validatorId === id,
      );
      expect(referenced || absorbed, id).toBe(true);
    }
  });

  it('fails hash-pinned allowlist drift when body changes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'launch-argv-hash-'));
    tempDirs.push(tmp);
    const rel = 'scripts/hash-pin-probe.ts';
    const source = "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['--version']);\n";
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, rel), source, 'utf8');
    const hash = hashNormalizedBody(source);
    const hit = {
      file: rel,
      line: 2,
      patternId: 'spawnSync' as const,
      lineText: "spawnSync('node', ['--version']);",
      classification: 'production' as const,
    };
    const match = matchDiscoveryHit(hit, [], [{ path: rel, patternId: 'spawnSync', sourceHash: hash, rowId: 'hash-pin' }], tmp);
    expect(match.outcome).toBe('inventoried');

    const drifted = matchDiscoveryHit(
      hit,
      [],
      [{ path: rel, patternId: 'spawnSync', sourceHash: 'sha256:deadbeef', rowId: 'hash-pin' }],
      tmp,
    );
    expect(drifted.outcome).toBe('allowlist-drift');
  });

  it('side-process launch-contract guard self-test stays green (#641-shape)', () => {
    const guard = join(repoRoot, 'scripts/check-side-process-launch-contract.ps1');
    const mismatch = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        guard,
        '-RegistryPath',
        join(fixtureRoot, 'side-process-mismatch/registry-mismatch.json'),
        '-ScriptsRoot',
        join(fixtureRoot, 'side-process-mismatch'),
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: pwshTimeoutMs },
    );
    expect(mismatch.status).not.toBe(0);
    expect(`${mismatch.stdout}${mismatch.stderr}`).toMatch(/ProjectId/i);
  });
});
