#!/usr/bin/env node
/**
 * Fixture producer: reads runtime-value.txt from the fixture corpus root and emits JSON.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(here, '..');
const value = readFileSync(path.join(corpusRoot, 'runtime-value.txt'), 'utf8').trim();
process.stdout.write(`${JSON.stringify(value)}\n`);
