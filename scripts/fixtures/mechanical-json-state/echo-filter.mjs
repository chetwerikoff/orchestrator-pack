import { readStdinJson, runStdinJsonCli } from '../../../docs/review-mechanical-cli.mjs';

runStdinJsonCli('echo-filter.mjs', {
  echo() {
    return readStdinJson();
  },
});
