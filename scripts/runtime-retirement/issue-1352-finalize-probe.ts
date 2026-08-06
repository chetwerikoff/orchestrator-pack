#!/usr/bin/env -S node --experimental-strip-types
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { scanRetiredRuntimeSurfaces } from './retired-surface-guard.ts';

interface PullRequestEvent {
  readonly pull_request?: {
    readonly base?: { readonly sha?: string };
    readonly head?: { readonly ref?: string; readonly sha?: string };
  };
}

interface SurfaceDefinition {
  readonly id: string;
  readonly owningReference: string;
}

const expectedHeadRef = 'verify/pr-1378-finalize';
const expectedBaseHead = '9ad24d321f2d21fdec406c9e1d5d8748a9da155a';
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !existsSync(eventPath)) process.exit(0);

const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
const headRef = event.pull_request?.head?.ref ?? '';
if (headRef !== expectedHeadRef) process.exit(0);

const baseHead = event.pull_request?.base?.sha ?? '';
const verificationHead = event.pull_request?.head?.sha ?? '';
if (baseHead !== expectedBaseHead) {
  throw new Error(`unexpected PR base: expected ${expectedBaseHead}, received ${baseHead || '<empty>'}`);
}
if (!verificationHead) throw new Error('verification PR head SHA is missing');

execFileSync('git', ['cat-file', '-e', `${baseHead}^{commit}`], { stdio: 'inherit' });
execFileSync('git', ['cat-file', '-e', `${verificationHead}^{commit}`], { stdio: 'inherit' });
execFileSync('git', ['merge-base', '--is-ancestor', baseHead, verificationHead], { stdio: 'inherit' });

const tempRoot = mkdtempSync(join(tmpdir(), 'issue-1352-finalize-'));
const baseRoot = join(tempRoot, 'base');
const currentRoot = join(tempRoot, 'current');
mkdirSync(baseRoot, { recursive: true });
mkdirSync(currentRoot, { recursive: true });

function materialize(commit: string, destination: string, archiveName: string): void {
  const archive = join(tempRoot, archiveName);
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
}

materialize(baseHead, baseRoot, 'base.tar');
materialize(verificationHead, currentRoot, 'current.tar');
mkdirSync(join(baseRoot, 'scripts/json-producers'), { recursive: true });
copyFileSync(
  join(currentRoot, 'scripts/json-producers/retired-runtime-surfaces.json'),
  join(baseRoot, 'scripts/json-producers/retired-runtime-surfaces.json'),
);

for (const temporaryPath of [
  '.github/workflows/issue-1352-finalize.yml',
  'scripts/runtime-retirement/issue-1352-finalize-probe.ts',
]) {
  rmSync(join(currentRoot, temporaryPath), { force: true });
}

const workerClaimPath = join(currentRoot, 'scripts/lib/Worker-NudgeClaim.ps1');
let workerClaim = readFileSync(workerClaimPath, 'utf8');
const accidental = "return @{ acquired = $false; reason = 'lost_race'; path = $path; namespace = $resolved; key = $record.key }";
const restored = "return @{ acquired = $false; reason = 'lost_race'; path = $path; namespace = $resolved; key = $key }";
const accidentalCount = workerClaim.split(accidental).length - 1;
if (accidentalCount !== 1) {
  throw new Error(`expected one accidental equivalent Worker-NudgeClaim change, received ${accidentalCount}`);
}
workerClaim = workerClaim.replace(accidental, restored);
if (workerClaim.includes('.agent-orchestrator')) {
  throw new Error('retired .agent-orchestrator fallback remains in Worker-NudgeClaim.ps1');
}
const packRootCount = workerClaim.split('.orchestrator-pack').length - 1;
if (packRootCount < 4) throw new Error(`expected at least four pack-owned roots, received ${packRootCount}`);
writeFileSync(workerClaimPath, workerClaim, 'utf8');

const baseScan = scanRetiredRuntimeSurfaces({ repoRoot: baseRoot });
const finalScan = scanRetiredRuntimeSurfaces({ repoRoot: currentRoot });
const surfaceDocument = JSON.parse(
  readFileSync(join(currentRoot, 'scripts/json-producers/retired-runtime-surfaces.json'), 'utf8'),
) as { readonly version: number; readonly surfaces: readonly SurfaceDefinition[] };
const surfaceById = new Map(surfaceDocument.surfaces.map((surface) => [surface.id, surface]));
const occurrenceCounts = new Map<string, number>();
const items = baseScan.violations.map((violation) => {
  const occurrenceKey = [violation.surfaceId, violation.path, violation.line, violation.match].join('\0');
  const ordinal = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
  occurrenceCounts.set(occurrenceKey, ordinal);
  const identitySource = `${occurrenceKey}\0${ordinal}`;
  const identity = `ao-retirement-${createHash('sha256').update(identitySource).digest('hex').slice(0, 24)}`;
  const retainedPath = existsSync(join(currentRoot, violation.path));
  const plannedDisposition = retainedPath ? 'ported' : 'deleted';
  return {
    identity,
    path: violation.path,
    selector: { line: violation.line, match: violation.match, ordinal },
    aoClass: violation.surfaceId,
    reason: violation.reason,
    owningReference: surfaceById.get(violation.surfaceId)?.owningReference ?? 'Issue #1352',
    plannedDisposition,
    rationale: retainedPath
      ? 'active path retained, while the retired runtime identity is replaced by RuntimeAdapter behavior'
      : 'retired runtime path removed from the active repository estate',
  };
});

const payload = {
  schemaVersion: 1,
  issue: 1352,
  initialBaseHead: expectedBaseHead,
  prBaseHead: baseHead,
  verificationHead,
  scannerPatternVersion: surfaceDocument.version,
  baseScan,
  finalScan,
  items,
};
const encoded = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
console.log('ISSUE1352_EVIDENCE_GZIP_B64_BEGIN');
for (let offset = 0; offset < encoded.length; offset += 120) console.log(encoded.slice(offset, offset + 120));
console.log('ISSUE1352_EVIDENCE_GZIP_B64_END');
console.log(`issue-1352 baseline identities: ${items.length}`);
console.log(`issue-1352 final active violations: ${finalScan.violations.length}`);

execFileSync(process.execPath, [
  '--experimental-strip-types',
  'scripts/runtime-retirement/retired-surface-selftest.ts',
], { stdio: 'inherit' });
execFileSync('npx', [
  'vitest',
  'run',
  '--config',
  'scripts/toolchain/vitest-foundation.config.ts',
  'scripts/runtime-retirement/retired-surface-guard.test.ts',
], { stdio: 'inherit' });

rmSync(tempRoot, { recursive: true, force: true });
if (baseScan.violations.length === 0) throw new Error('frozen base census unexpectedly contains zero identities');
if (finalScan.violations.length > 0) {
  throw new Error(`final retirement scan contains ${finalScan.violations.length} active violations`);
}
