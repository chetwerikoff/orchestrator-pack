import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NodeMajorCheck {
  readonly expected: number;
  readonly actual: number;
  readonly ok: boolean;
}

export function parseNodeMajor(value: string): number {
  const match = /^v?(\d+)(?:\.|$)/.exec(value.trim());
  if (!match?.[1]) throw new Error(`cannot parse Node major from ${JSON.stringify(value)}`);
  return Number(match[1]);
}

export function checkNodeMajor(expectedText: string, actualVersion: string): NodeMajorCheck {
  const expected = parseNodeMajor(expectedText);
  const actual = parseNodeMajor(actualVersion);
  return { expected, actual, ok: expected === actual };
}

export function runNodeMajorCheck(repoRoot = process.cwd()): NodeMajorCheck {
  const expectedText = readFileSync(resolve(repoRoot, '.nvmrc'), 'utf8');
  return checkNodeMajor(expectedText, process.versions.node);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const result = runNodeMajorCheck();
  if (!result.ok) {
    process.stderr.write(`Node major mismatch: expected ${result.expected}, running ${result.actual}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Node major ${result.actual} matches .nvmrc\n`);
  }
}
