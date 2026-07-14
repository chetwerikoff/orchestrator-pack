import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';

export interface NodeMajorCheck {
  readonly expected: number;
  readonly actual: number;
  readonly ok: boolean;
}

interface PackageManifest {
  readonly engines?: {
    readonly node?: string;
  };
}

export function parseNodeMajor(value: string): number {
  const match = /^(?:\^|~|>=|>|=)?\s*v?(\d+)(?:\.|\b)/.exec(value.trim());
  if (!match?.[1]) throw new Error(`cannot parse Node major from ${JSON.stringify(value)}`);
  return Number(match[1]);
}

export function checkNodeMajor(expectedText: string, actualVersion: string): NodeMajorCheck {
  const expected = parseNodeMajor(expectedText);
  const actual = parseNodeMajor(actualVersion);
  return { expected, actual, ok: expected === actual };
}

export function runNodeMajorCheck(repoRoot = process.cwd()): NodeMajorCheck {
  const packageManifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  const expectedText = packageManifest.engines?.node;
  if (!expectedText) throw new Error('package.json engines.node must pin the supported Node major');
  return checkNodeMajor(expectedText, process.versions.node);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const result = runNodeMajorCheck();
  if (!result.ok) {
    process.stderr.write(`Node major mismatch: expected ${result.expected}, running ${result.actual}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Node major ${result.actual} matches package.json engines.node\n`);
  }
}
