#!/usr/bin/env node
const specifier = './value-helper.mjs';
const { value } = await import(specifier);

process.stdout.write(`${JSON.stringify(value)}\n`);
