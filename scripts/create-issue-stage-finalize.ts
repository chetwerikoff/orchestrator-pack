#!/usr/bin/env node
import {
  bootstrapCreateIssueCli,
  runStageFinalizeCli,
} from './lib/create-issue-stage-record-cli.ts';

export { runStageFinalizeCli as runCli } from './lib/create-issue-stage-record-cli.ts';

bootstrapCreateIssueCli(import.meta.url, process.argv[1], runStageFinalizeCli);
