#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync, type ProcessResult } from '#opk-kernel/subprocess';

export type GhJsonRoot = 'array' | 'object' | 'number' | 'any';
export type GhSignalClassification =
  | 'success'
  | 'empty'
  | 'command-failure'
  | 'spawn-failure'
  | 'malformed-json'
  | 'wrong-root';

export interface GhJsonCapture {
  readonly outcome?: ProcessResult['outcome'];
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface GhJsonCommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly expectedRoot?: GhJsonRoot;
  readonly allowedExitCodes?: readonly number[];
  readonly fixturePath?: string;
}

export interface GhJsonSignalResult {
  readonly ok: boolean;
  readonly classification: GhSignalClassification;
  readonly reason: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly value?: unknown;
  readonly error?: string;
}

function normalizeExpectedRoot(value: unknown): GhJsonRoot {
  const root = String(value ?? 'any');
  if (root === 'array' || root === 'object' || root === 'number' || root === 'any') return root;
  throw new TypeError(`unsupported expectedRoot: ${root}`);
}

function normalizeAllowedExitCodes(value: unknown): number[] {
  if (value === undefined) return [0];
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('allowedExitCodes must be a non-empty integer array');
  }
  const normalized = value.map((entry) => Number(entry));
  if (normalized.some((entry) => !Number.isInteger(entry))) {
    throw new TypeError('allowedExitCodes must contain integers only');
  }
  return [...new Set(normalized)];
}

function rootMatches(value: unknown, expectedRoot: GhJsonRoot): boolean {
  switch (expectedRoot) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'any':
      return true;
  }
}

function captureSignal(capture: GhJsonCapture): NodeJS.Signals | null {
  return capture.signal ?? null;
}

export function classifyGhJsonCapture(
  capture: GhJsonCapture,
  options: Pick<GhJsonCommandRequest, 'expectedRoot' | 'allowedExitCodes'> = {},
): GhJsonSignalResult {
  const expectedRoot = normalizeExpectedRoot(options.expectedRoot);
  const allowedExitCodes = normalizeAllowedExitCodes(options.allowedExitCodes);
  const outcome = capture.outcome ?? 'exit';
  const base = {
    exitCode: capture.exitCode,
    signal: captureSignal(capture),
    stdout: String(capture.stdout ?? ''),
    stderr: String(capture.stderr ?? ''),
    ...(capture.error ? { error: String(capture.error) } : {}),
  };

  if (outcome !== 'exit' || capture.exitCode === null) {
    return {
      ok: false,
      classification: 'spawn-failure',
      reason: outcome === 'signal' ? 'gh_terminated_by_signal' : 'gh_spawn_failed',
      ...base,
    };
  }

  if (!allowedExitCodes.includes(capture.exitCode)) {
    return {
      ok: false,
      classification: 'command-failure',
      reason: 'gh_command_failed',
      ...base,
    };
  }

  const stdout = base.stdout.trim();
  if (!stdout) {
    return {
      ok: false,
      classification: 'malformed-json',
      reason: 'gh_empty_stdout',
      ...base,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      classification: 'malformed-json',
      reason: 'gh_json_parse_failed',
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!rootMatches(value, expectedRoot)) {
    return {
      ok: false,
      classification: 'wrong-root',
      reason: `gh_json_root_mismatch:${expectedRoot}`,
      ...base,
      value,
    };
  }

  const empty = expectedRoot === 'array' && Array.isArray(value) && value.length === 0;
  return {
    ok: true,
    classification: empty ? 'empty' : 'success',
    reason: empty ? 'gh_json_empty_success' : 'gh_json_success',
    ...base,
    value,
  };
}

function readFixtureCapture(fixturePath: string): GhJsonCapture {
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf8')) as Partial<GhJsonCapture>;
  if (typeof parsed.stdout !== 'string' || typeof parsed.stderr !== 'string') {
    throw new TypeError('gh signal fixture requires string stdout and stderr');
  }
  if (parsed.exitCode !== null && !Number.isInteger(parsed.exitCode)) {
    throw new TypeError('gh signal fixture exitCode must be an integer or null');
  }
  return {
    outcome: parsed.outcome ?? 'exit',
    exitCode: parsed.exitCode ?? null,
    signal: parsed.signal ?? null,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}

function isPaginatedApiRequest(args: readonly string[]): boolean {
  return args[0] === 'api' && args.includes('--paginate');
}

function prepareCommandArgs(args: readonly string[], expectedRoot: GhJsonRoot): string[] {
  const prepared = [...args];
  if (expectedRoot === 'array' && isPaginatedApiRequest(prepared) && !prepared.includes('--slurp')) {
    prepared.push('--slurp');
  }
  return prepared;
}

function normalizePaginatedApiResult(
  result: GhJsonSignalResult,
  requestedArgs: readonly string[],
  expectedRoot: GhJsonRoot,
): GhJsonSignalResult {
  if (!result.ok || expectedRoot !== 'array' || !isPaginatedApiRequest(requestedArgs) || !Array.isArray(result.value)) {
    return result;
  }

  const value = result.value.flatMap((page) => Array.isArray(page) ? page : [page]);
  const empty = value.length === 0;
  return {
    ...result,
    classification: empty ? 'empty' : 'success',
    reason: empty ? 'gh_json_empty_success' : 'gh_json_success',
    value,
  };
}

export function runGhJsonCommand(request: GhJsonCommandRequest): GhJsonSignalResult {
  const command = String(request.command ?? '').trim();
  if (!command) throw new TypeError('gh signal command is required');
  const requestedArgs = Array.isArray(request.args) ? request.args.map((entry) => String(entry)) : [];
  const expectedRoot = normalizeExpectedRoot(request.expectedRoot);
  const args = prepareCommandArgs(requestedArgs, expectedRoot);
  const capture = request.fixturePath
    ? readFixtureCapture(path.resolve(request.fixturePath))
    : runProcessSync({
      command,
      args,
      cwd: request.cwd ? path.resolve(request.cwd) : undefined,
      inheritParentEnv: true,
      encoding: 'utf8',
    });
  const result = classifyGhJsonCapture(capture, {
    expectedRoot,
    allowedExitCodes: request.allowedExitCodes,
  });
  return normalizePaginatedApiResult(result, requestedArgs, expectedRoot);
}

function cliValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== 'run') {
    throw new Error('usage: gh-signal-classifier.ts run --input-file <path> --output-file <path>');
  }
  const inputPath = cliValue('--input-file');
  const outputPath = cliValue('--output-file');
  if (!inputPath || !outputPath) {
    throw new Error('gh-signal-classifier requires --input-file and --output-file');
  }
  const request = JSON.parse(readFileSync(inputPath, 'utf8')) as GhJsonCommandRequest;
  const result = runGhJsonCommand(request);
  writeFileSync(outputPath, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`gh-signal-classifier: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
