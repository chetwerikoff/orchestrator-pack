#!/usr/bin/env node
const { value } = await import('./value-helper.mjs');

function formatJsonOutput(raw) {
  const trimmed = String(raw).trim();
  if (
    trimmed.startsWith('{')
    || trimmed.startsWith('[')
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

process.stdout.write(`${formatJsonOutput(value)}\n`);
