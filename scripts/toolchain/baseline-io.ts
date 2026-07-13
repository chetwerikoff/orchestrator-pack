import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function writeVersionOneBaseline(path: string, entries: readonly unknown[]): void {
  const serializedEntries = entries.map((entry, index) =>
    `    ${JSON.stringify(entry)}${index === entries.length - 1 ? '' : ','}`,
  );
  writeFileSync(path, ['{', '  "version": 1,', '  "entries": [', ...serializedEntries, '  ]', '}', ''].join('\n'));
}

export function isDirectExecution(importMetaUrl: string, entry: string | undefined): boolean {
  return entry !== undefined && importMetaUrl === pathToFileURL(resolve(entry)).href;
}
