#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Options = {
  headSha: string;
  runId: string;
  workflowUrl: string;
  dryRun: boolean;
  simulateDeliveryFailure: boolean;
};

function parseArgs(argv: string[]): Options {
  const out: Options = {
    headSha: '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    workflowUrl: (process.env.GITHUB_SERVER_URL ?? '') + '/' + (process.env.GITHUB_REPOSITORY ?? '') + '/actions/runs/' + (process.env.GITHUB_RUN_ID ?? ''),
    dryRun: false,
    simulateDeliveryFailure: false,
  };
  const valueArgs = new Map<string, keyof Pick<Options, 'headSha' | 'runId' | 'workflowUrl'>>([
    ['--head-sha', 'headSha'], ['-HeadSha', 'headSha'],
    ['--run-id', 'runId'], ['-RunId', 'runId'],
    ['--workflow-url', 'workflowUrl'], ['-WorkflowUrl', 'workflowUrl'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry-run' || arg === '-DryRun') out.dryRun = true;
    else if (arg === '--simulate-delivery-failure' || arg === '-SimulateDeliveryFailure') out.simulateDeliveryFailure = true;
    else {
      const key = valueArgs.get(arg);
      if (!key) throw new Error('unknown argument: ' + arg);
      const value = argv[++index];
      if (!value) throw new Error('missing value for ' + arg);
      out[key] = value;
    }
  }
  if (!out.headSha) throw new Error('missing required --head-sha');
  return out;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const manifestUrl = new URL('./vitest-wallclock-e2e-split.manifest.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
    issue: number;
    redSignal: { episodeKey: string; dedupeKey: string; owner: string; deliveryTarget: string };
    preMoveEnumeratedFiles: unknown;
  };
  const episodeKey = manifest.redSignal.episodeKey.replace('{sha}', options.headSha);
  const dedupeKey = manifest.redSignal.dedupeKey.replace('{sha}', options.headSha);
  const payload: Record<string, unknown> = {
    schema: 'wallclock-e2e-failure.v1',
    issue: 694,
    headSha: options.headSha,
    runId: options.runId,
    episodeKey,
    dedupeKey,
    owner: manifest.redSignal.owner,
    deliveryTarget: manifest.redSignal.deliveryTarget,
    workflowUrl: options.workflowUrl,
    enumeratedMove: manifest.preMoveEnumeratedFiles,
    triageHint: 'Inspect vitest-wallclock-e2e workflow run for failing postMergeWallclock file; do not treat PR aggregate as wall-clock pass.',
  };
  if (options.dryRun) {
    payload.dryRun = true;
    console.log(JSON.stringify(payload));
    if (options.simulateDeliveryFailure) {
      console.error('[FAIL] wall-clock alert delivery simulated failure (fail-closed)');
      return 1;
    }
    console.log('[PASS] wall-clock alert dry-run delivery payload emitted');
    return 0;
  }
  if (options.simulateDeliveryFailure) {
    console.error('[FAIL] wall-clock alert delivery failed (fail-closed; stage remains red)');
    return 1;
  }
  const storeDir = (process.env.OPK_CI_FAILURE_NOTIFICATION_STORE ?? '').trim()
    || join(tmpdir(), 'orchestrator-ci-failure-notification', 'orchestrator-pack');
  mkdirSync(storeDir, { recursive: true });
  const recordPath = join(storeDir, 'wallclock-e2e-' + options.headSha + '.json');
  writeFileSync(recordPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('[PASS] wall-clock failure alert recorded episode=' + episodeKey + ' path=' + recordPath);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
