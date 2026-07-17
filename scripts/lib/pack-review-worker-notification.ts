import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runProcess } from '../kernel/subprocess.js';
import {
  packReviewDeliveryNeedsResume as basePackReviewDeliveryNeedsResume,
} from './pack-review-delivery.ts';
import type {
  PackReviewWorkerNotificationRequest,
  PackReviewWorkerNotificationResult,
} from './pack-review-delivery.ts';
import {
  trimPackReviewValue as trim,
  type PackReviewRunRecord,
} from './pack-review-run-store.js';

interface WorkerNotificationOptions {
  trustedPackRoot: string;
  sessionId: string;
  request: PackReviewWorkerNotificationRequest;
  repoRoot?: string;
  projectId?: string;
  prNumber?: number;
  headSha?: string;
}

const WORKER_NOTIFICATION_ADAPTER = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
$payload = $payloadText | ConvertFrom-Json
$root = [string]$env:PACK_REVIEW_TRUSTED_ROOT
if (-not $root) { throw 'PACK_REVIEW_TRUSTED_ROOT is required' }
. (Join-Path $root 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1')
. (Join-Path $root 'scripts/lib/Review-DeliveryLifecycle.ps1')

$sessionId = [string]$payload.sessionId
$projectId = [string]$payload.projectId
$repoRoot = [string]$payload.repoRoot
$prNumber = [int]$payload.prNumber
$headSha = [string]$payload.headSha
$deliveryKey = [string]$payload.deliveryKey
$message = [string]$payload.message
$findingsHash = [string]$payload.findingsHash
$workerTarget = ''
$openPrs = $null

$fixtureTarget = [string]$env:PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET
if ($env:OPK_VITEST_HARNESS -eq '1' -and $fixtureTarget) {
    $workerTarget = $fixtureTarget
}
else {
    $resolved = Resolve-ScriptedReviewDeliveryWorkerSession -PrNumber $prNumber -HeadSha $headSha -ProjectId $projectId -RepoRoot $repoRoot
    if (-not $resolved.ok) {
        @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$resolved.reason } |
            ConvertTo-Json -Compress -Depth 8
        exit 0
    }
    $sessionId = [string]$resolved.sessionId
    $openPrs = @($resolved.openPrs)
    $target = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $prNumber -SessionId $sessionId -HeadSha $headSha -ProjectId $projectId -OpenPrs $openPrs
    if (-not $target.ok) {
        @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$target.reason } |
            ConvertTo-Json -Compress -Depth 8
        exit 0
    }
    $workerTarget = [string]$target.workerTarget
}

$delivery = New-ReviewDeliveryDeterministicDeliveryId -SessionId $sessionId -DeliveryKey $deliveryKey
if (-not $delivery.ok) {
    @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$delivery.reason } |
        ConvertTo-Json -Compress -Depth 8
    exit 0
}

$result = Invoke-ScriptedReviewStdoutDeliverySend -SessionId $sessionId -MessageText $message -DeliveryKey $deliveryKey -DeliveryId ([string]$delivery.deliveryId) -PrNumber $prNumber -TargetSha $headSha -ProjectId $projectId -FindingsHash $findingsHash -WorkerTarget $workerTarget -OpenPrs $openPrs
$result | ConvertTo-Json -Compress -Depth 8
`;

function writeCapture(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseTarget(options: WorkerNotificationOptions): {
  prNumber: number;
  headSha: string;
} | null {
  const key = trim(options.request.idempotencyKey);
  const keyMatch = key.match(/^worker-notification:[^:]+:([0-9a-f]{40})$/i);
  const messageMatch = trim(options.request.message).match(/Pack review completed for PR #(\d+)\./);
  const prNumber = Number(options.prNumber ?? messageMatch?.[1]);
  const headSha = trim(options.headSha ?? keyMatch?.[1]).toLowerCase();
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  return { prNumber, headSha };
}

function parseAdapterResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Ignore non-JSON diagnostics and continue to the final structured result.
    }
  }
  return null;
}

export async function sendPackReviewWorkerNotification(
  options: WorkerNotificationOptions,
): Promise<PackReviewWorkerNotificationResult> {
  const sessionId = trim(options.sessionId);
  if (!sessionId) return { state: 'escalated', reason: 'worker_session_unresolved' };

  const capture = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE);
  const realAdapter = process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER === '1';
  if (process.env.OPK_VITEST_HARNESS === '1' && !realAdapter) {
    if (capture) {
      writeCapture(capture, {
        sessionId,
        message: options.request.message,
        idempotencyKey: options.request.idempotencyKey,
      });
    }
    return { state: 'delivered', reason: 'fixture_dispatched' };
  }

  const target = parseTarget(options);
  if (!target) return { state: 'escalated', reason: 'worker_notification_target_unresolved' };
  const trustedPackRoot = resolve(options.trustedPackRoot);
  const findingsHash = `sha256:${createHash('sha256').update(options.request.message, 'utf8').digest('hex')}`;
  const request = `${JSON.stringify({
    sessionId,
    projectId: trim(options.projectId) || 'orchestrator-pack',
    repoRoot: resolve(options.repoRoot || trustedPackRoot),
    prNumber: target.prNumber,
    headSha: target.headSha,
    deliveryKey: trim(options.request.idempotencyKey),
    findingsHash,
    message: options.request.message,
  })}\n`;
  const result = await runProcess({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', WORKER_NOTIFICATION_ADAPTER],
    input: request,
    cwd: trustedPackRoot,
    inheritParentEnv: true,
    env: { PACK_REVIEW_TRUSTED_ROOT: trustedPackRoot },
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  const parsed = parseAdapterResult(result.stdout);
  if (result.ok && parsed) {
    const reason = trim(parsed.reason) || 'adapter_dispatched';
    if (trim(parsed.terminal) === 'delivered' || parsed.ok === true) {
      return { state: 'delivered', reason };
    }
    if (trim(parsed.terminal) === 'escalated') return { state: 'escalated', reason };
    return { state: 'failed', reason };
  }
  const reason = trim(result.stderr || result.error || result.stdout) || result.outcome;
  return {
    state: result.timedOut || result.cancelled ? 'escalated' : 'failed',
    reason,
  };
}

export function packReviewDeliveryNeedsResume(run: PackReviewRunRecord): boolean {
  const worker = run.deliveryOutcomes?.workerNotification;
  const expectedKey = `worker-notification:${run.id}:${run.targetSha}`;
  if (!worker
    || worker.idempotencyKey !== expectedKey
    || (worker.state !== 'failed' && worker.state !== 'escalated')) {
    return basePackReviewDeliveryNeedsResume(run);
  }
  return basePackReviewDeliveryNeedsResume({
    ...run,
    deliveryOutcomes: {
      ...run.deliveryOutcomes,
      workerNotification: { ...worker, state: 'delivered' },
    },
  });
}
