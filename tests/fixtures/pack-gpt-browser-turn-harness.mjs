#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const outputPath = argValue('--output');
const inputPath = argValue('--input');
if (!outputPath || !inputPath) {
  console.error('harness requires --input and --output');
  process.exit(10);
}

const prompt = readFileSync(inputPath, 'utf8');
if (!prompt.includes('github.com') || !prompt.includes('/pull/')) {
  console.error('harness prompt missing PR URL');
  process.exit(10);
}

writeFileSync(outputPath, 'NO_FINDINGS', 'utf8');
process.stdout.write(`${JSON.stringify({
  schema: 'turn-result/v1',
  state: 'ok',
  scope: 'none',
  cause: 'completed_page_only',
  invocation_id: '00000000-0000-4000-8000-000000000001',
  configured_profile_key: 'fixture-profile',
  send_count: 1,
  poll_count: 1,
  goto_count: 1,
  new_chat_click_count: 0,
  navigation_count: 1,
  incidents: [],
  output: { byte_length: 11, sha256: '68faf648728e1563dce0162523dad670123775c56ca6fa6813b9220f5c383217' },
  cleanup: 'confirmed',
})}\n`);
