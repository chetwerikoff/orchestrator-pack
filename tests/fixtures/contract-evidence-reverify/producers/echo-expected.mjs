#!/usr/bin/env node
/**
 * Hand-shaped proof fixture: echoes expected datum without observable producer-path invocation.
 */
const expected = process.env.REVERIFY_EXPECTED ?? 'divergent';
process.stdout.write(JSON.stringify({ 'reverify-status': expected }));
