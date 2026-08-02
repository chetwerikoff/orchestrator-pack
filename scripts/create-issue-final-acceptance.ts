#!/usr/bin/env node
import {
  bootstrapCreateIssueCli,
  runFinalAcceptanceCli,
} from './lib/create-issue-stage-record-cli.ts';

export { runFinalAcceptanceCli as runCli } from './lib/create-issue-stage-record-cli.ts';
export {
  checkRemoteAuthority,
  deriveAdmission,
  validateTopology,
} from './lib/create-issue-stage-topology.ts';

bootstrapCreateIssueCli(import.meta.url, process.argv[1], runFinalAcceptanceCli);
