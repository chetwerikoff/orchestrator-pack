#!/usr/bin/env node
import { buildCiFailureFixingStintProofPayload } from './lib/ci-failure-fixing-stint-proof.mjs';

process.stdout.write(`${JSON.stringify(buildCiFailureFixingStintProofPayload())}\n`);
