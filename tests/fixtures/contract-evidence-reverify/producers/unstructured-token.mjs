#!/usr/bin/env node
/** Fixture producer: unstructured capture text for token-based rows. */
const token = process.env.REVERIFY_TOKEN ?? 'fixture-token';
process.stdout.write(`output prefix ${token} suffix\n`);
