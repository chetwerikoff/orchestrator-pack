import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { foundationEvidenceDigest, writeDurableJson } from '../lib/cutover/activation-evidence.ts';
import { productionActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import {
  canonicalFoundationPaths,
  observeFoundationInertProof,
  observeLocalHeartbeat,
} from '../lib/cutover/foundation-observation.ts';
import { sanitizeRuntimeWorkers } from '../pr2-foundation/binding.ts';
import { DEFAULT_FOUNDATION_CONFIG } from '../pr2-foundation/config.ts';
import { FOUNDATION_RUNTIME_CATALOG } from '../pr2-foundation/runtime-catalog.ts';
import { FOUNDATION_COMMIT } from '../pr2a/contracts.ts';
import type { ActivationRequest, FoundationAdmissionEvidence } from '../lib/cutover/types.ts';

const repoRoot = path.resolve(process.cwd());
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('Issue 1422 production admission', () => {
  it('rejects fully hand-authored rehashed evidence after live preflight re-observation', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'opk-1422-production-home-'));
    roots.push(home);
    const user = os.userInfo();
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...user, homedir: home });
    const previousPath = process.env.PATH;
    const bin = path.join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const ao = path.join(bin, 'ao');
    const liveRow = {
      createdAt: new Date().toISOString(),
      harness: 'production-test',
      id: 'live-source',
      isTerminated: false,
      issueId: 1422,
      lastActivityAt: new Date().toISOString(),
      projectId: 'production-test',
      role: 'live',
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(ao, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ sessions: [liveRow] }))});\n`);
    chmodSync(ao, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const previousOverride = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const previousAdapter = process.env.OPK_RUNTIME_ADAPTER;
    delete process.env.OPK_RUNTIME_ADAPTER;

    try {
      const canonical = canonicalFoundationPaths(repoRoot);
      mkdirSync(canonical.supervisorStateDir, { recursive: true });
      const config = {
        ...DEFAULT_FOUNDATION_CONFIG,
        notification: { ...DEFAULT_FOUNDATION_CONFIG.notification, runtimePath: 'ao' },
      };
      writeJson(canonical.configPath, config);
      writeJson(canonical.appStatePath, { version: '0.10.3' });
      const journalPath = path.join(canonical.stateRoot, 'migration-journal.json');
      writeJson(journalPath, {
        schemaVersion: 1,
        journalKey: 'issue-1422-production-test',
        sourcePath: path.join(home, 'source.json'),
        targetPath: path.join(home, 'target.json'),
        sourceDigest: 'sha256:source',
        importedDigest: 'sha256:target',
        archiveIdentity: 'sha256:archive',
        state: 'committed',
        preparedAt: '2026-08-16T00:00:00.000Z',
        importedAt: '2026-08-16T00:00:01.000Z',
        committedAt: '2026-08-16T00:00:02.000Z',
      });
      const paths = {
        stateRoot: canonical.stateRoot,
        stateDir: canonical.stateRoot,
        cordonPath: canonical.cordonPath,
        phaseOnePath: canonical.phaseOnePath,
        followupPath: canonical.followupPath,
        epochAuthorityPath: canonical.epochAuthorityPath,
        targetRegistryPath: path.join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'),
        projectedRegistryPath: canonical.projectedRegistryPath,
        snapshotDir: canonical.snapshotDir,
        supervisorStateDir: canonical.supervisorStateDir,
        foundationEvidencePath: canonical.evidencePath,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
      };
      const hostId = os.hostname().trim();
      const request = {
        repoRoot,
        oldInstalledRevisionRoot: repoRoot,
        hostId,
        knownMemberRoster: [{ hostId }],
        paths,
      } as unknown as ActivationRequest;
      const inertProof = observeFoundationInertProof({ repoRoot, paths });
      const handAuthoredRows = sanitizeRuntimeWorkers([{ ...liveRow, role: 'hand-authored' }]);
      const unsigned: Omit<FoundationAdmissionEvidence, 'observationDigest'> = {
        schemaVersion: 1,
        issue: 923,
        foundationMergeCommitSha: FOUNDATION_COMMIT,
        producer: 'orchestrator-pack:foundation-adoption-producer',
        preflight: {
          command: 'a\u006f session ls --json',
          appStateVersion: '0.10.3',
          sessions: handAuthoredRows,
          sanitizerId: `sha256:${'1'.repeat(64)}`,
        },
        typedConfig: config,
        migrationJournalPaths: [path.resolve(journalPath)],
        runtimeCatalog: [...FOUNDATION_RUNTIME_CATALOG],
        inertProof,
        heartbeats: [observeLocalHeartbeat(hostId, 'c'.repeat(40), canonical.configPath)],
      };
      writeDurableJson(canonical.evidencePath, {
        ...unsigned,
        observationDigest: foundationEvidenceDigest(unsigned),
      });

      await expect(productionActivationBoundary.proveFoundationAdoption(request))
        .rejects.toThrow('foundation_evidence_observation_mismatch:preflight');
      expect(new FileEpochAuthority(canonical.epochAuthorityPath).read().currentEpochId).toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousOverride;
      if (previousAdapter === undefined) delete process.env.OPK_RUNTIME_ADAPTER;
      else process.env.OPK_RUNTIME_ADAPTER = previousAdapter;
    }
  });
});
