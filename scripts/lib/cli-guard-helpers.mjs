import { readFileSync } from 'node:fs';

export function cliFail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

export function loadJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
