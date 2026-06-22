#!/usr/bin/env node
/** Repo-owned producer boundary for NEW-row fulfillment tests. */
const status = process.env.REVERIFY_STATUS ?? 'verified';
process.stdout.write(JSON.stringify({ 'reverify-status': status }));
