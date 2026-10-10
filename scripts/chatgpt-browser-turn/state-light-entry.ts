#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runStateLightTurn } from './state-light-turn.ts';
import { settleCliMain } from './cli-main.ts';
import type { GptBrowserTurnConfig } from '../lib/pack-gpt-reviewer.ts';
import type { TargetContext } from '../lib/target-context.ts';

type OwnerInspection = { readonly ok: boolean; readonly reason?: string; readonly timedOut?: boolean };
export type PackReviewPreflightDependencies = {
  readonly resolveTarget?: (input: { projectId: string; env: Readonly<NodeJS.ProcessEnv> }) => TargetContext;
  readonly resolveBrowserConfig?: (env: NodeJS.ProcessEnv) => GptBrowserTurnConfig;
  readonly inspectOwner?: (input: { cdp: string; profile: string; timeoutMs: number }) => Promise<OwnerInspection>;
  readonly isReachable?: (cdp: string, options: { timeoutMs: number }) => Promise<boolean>;
  readonly now?: () => number;
};

export type StateLightEntryDependencies = {
  readonly runTurn?: typeof runStateLightTurn;
  readonly preflight?: PackReviewPreflightDependencies;
};

export type PackReviewPreflightResult = {
  readonly route: 'pack-gpt-reviewer';
  readonly outcome: 'pass' | 'incomplete';
  readonly reason: string;
  readonly handle_present: boolean;
  readonly elapsed_ms: number;
};

/** The CLI never accepts an arbitrary browser pair; only the pack-review resolver may select it. */
export function parsePackReviewPreflightArgs(argv: readonly string[]): { projectId: string; timeoutMs: number } {
  const allowed = new Set(['--route', '--project', '--timeout-ms']);
  const options = new Map<string, string>();
  if (argv.length !== 6) throw new Error('preflight_arguments_unverified');
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? '';
    const value = argv[i + 1] ?? '';
    if (!allowed.has(key) || options.has(key) || !value.trim() || value.startsWith('--')) {
      throw new Error('preflight_arguments_unverified');
    }
    options.set(key, value.trim());
  }
  if (options.get('--route') !== 'pack-gpt-reviewer') throw new Error('preflight_route_unverified');
  const projectId = options.get('--project') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) throw new Error('preflight_project_unverified');
  const rawBudget = options.get('--timeout-ms') ?? '';
  if (!/^[1-9][0-9]*$/u.test(rawBudget)) throw new Error('preflight_budget_unverified');
  const timeoutMs = Number(rawBudget);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 50_000) throw new Error('preflight_budget_unverified');
  return { projectId, timeoutMs };
}

export async function runPackReviewPreflight(
  argv: readonly string[],
  deps: PackReviewPreflightDependencies = {},
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PackReviewPreflightResult> {
  const now = deps.now ?? (() => performance.now());
  const began = now();
  const handle_present = Boolean(env.ORCA_TERMINAL_HANDLE?.trim());
  const report = (outcome: 'pass' | 'incomplete', reason: string): PackReviewPreflightResult => ({
    route: 'pack-gpt-reviewer', outcome, reason, handle_present,
    elapsed_ms: Math.max(0, Math.ceil(now() - began)),
  });
  try {
    const { projectId, timeoutMs } = parsePackReviewPreflightArgs(argv);
    const remaining = (): number => Math.max(0, Math.floor(timeoutMs - (now() - began)));
    if (env.OPK_PROJECT_ID?.trim() && env.OPK_PROJECT_ID.trim() !== projectId) {
      return report('incomplete', 'project_selector_mismatch');
    }
    const selectedEnv: NodeJS.ProcessEnv = { ...env, OPK_PROJECT_ID: projectId };
    const resolveTarget = deps.resolveTarget ?? (await import('../lib/target-context.ts')).resolveTargetContext;
    const target = resolveTarget({ projectId, env: selectedEnv });
    if (target.projectId !== projectId || target.repository !== 'chetwerikoff/orchestrator-pack') {
      return report('incomplete', 'selected_pack_card_mismatch');
    }
    const resolveBrowserConfig = deps.resolveBrowserConfig
      ?? (await import('../lib/pack-gpt-reviewer.ts')).resolveGptBrowserConfig;
    const config = resolveBrowserConfig(selectedEnv);
    // Reject a card change between selecting the target and resolving this actual review route.
    if (!config.profile?.trim() || !config.cdpUrl?.trim() || !config.projectUrl
      || config.projectUrl !== target.browserGpt.projectUrl || config.chatUrl) {
      return report('incomplete', 'route_configuration_unverified');
    }
    try {
      const url = new URL(config.cdpUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        return report('incomplete', 'route_configuration_unverified');
      }
    } catch {
      return report('incomplete', 'route_configuration_unverified');
    }
    if (remaining() <= 0) return report('incomplete', 'budget_exhausted');
    const module = deps.inspectOwner && deps.isReachable ? undefined : await import(pathToFileURL(resolve(
      dirname(fileURLToPath(import.meta.url)), '../../.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs',
    )).href) as {
      inspectCdpProfileBounded: NonNullable<PackReviewPreflightDependencies['inspectOwner']>;
      isCdpReachable: NonNullable<PackReviewPreflightDependencies['isReachable']>;
    };
    const inspectOwner = deps.inspectOwner ?? module!.inspectCdpProfileBounded;
    const isReachable = deps.isReachable ?? module!.isCdpReachable;
    const owner = await inspectOwner({ cdp: config.cdpUrl, profile: config.profile, timeoutMs: remaining() });
    if (owner.timedOut || remaining() <= 0) return report('incomplete', 'owner_probe_timeout');
    if (!owner.ok) {
      const known = new Set(['not_listening', 'uninspectable', 'no_user_data_dir', 'profile_mismatch']);
      return report('incomplete', known.has(owner.reason ?? '') ? `owner_${owner.reason}` : 'owner_unverified');
    }
    const reachable = await isReachable(config.cdpUrl, { timeoutMs: remaining() });
    if (remaining() <= 0) return report('incomplete', 'cdp_reachability_timeout');
    return reachable ? report('pass', 'selected_route_reachable') : report('incomplete', 'cdp_unreachable');
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason.startsWith('preflight_')) return report('incomplete', reason);
    return report('incomplete', reason === 'cdp_reachability_timeout' || (error instanceof Error
      && error.name === 'CdpReachabilityTimeoutError') ? 'cdp_reachability_timeout' : 'route_unverified');
  }
}

export async function runStateLightEntry(
  argv: readonly string[],
  deps: StateLightEntryDependencies = {},
): Promise<number> {
  const [command, ...turnArgs] = argv;
  if (command === 'preflight') {
    const result = await runPackReviewPreflight(turnArgs, deps.preflight);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.outcome === 'pass' ? 0 : 1;
  }
  const runTurn = deps.runTurn ?? runStateLightTurn;
  const turnOptions = { entryLivenessHeartbeat: true, recordChatBinding: true } as const;
  if (command === 'turn') return runTurn(turnArgs, turnOptions);
  if (command === 'cancel') {
    const { runStateLightCancellation } = await import('./state-light-cancellation.ts');
    return runStateLightCancellation(turnArgs);
  }
  if (command === 'session') {
    const { runStateLightSession } = await import('./state-light-session.ts');
    return runStateLightSession(turnArgs);
  }
  if (command?.startsWith('--')) return runTurn(argv, turnOptions);
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  return runCli(argv);
}

async function main(): Promise<void> {
  process.exitCode = await runStateLightEntry(process.argv.slice(2));
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  settleCliMain(main);
}
