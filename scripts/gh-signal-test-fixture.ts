import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GH_SIGNAL_TEST_HEAD = "a".repeat(40);

export interface GhSignalFakeOptions {
  defaultScenario?:
    "fleet" | "quiet" | "malformed" | "nonzero" | "empty-route" | "watchdog";
  alwaysDiagnostics?: boolean;
}

export function writeGhSignalFake(
  root: string,
  options: GhSignalFakeOptions = {},
): string {
  const executable = join(root, "gh");
  const defaultScenario = options.defaultScenario ?? "fleet";
  const alwaysDiagnostics = options.alwaysDiagnostics ?? false;
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const joined = args.join(' ');
const scenario = process.env.GH_SIGNAL_FAKE_SCENARIO || ${JSON.stringify(defaultScenario)};
const diagnostics = [
  'gh-wrapper-audit: complete route=fake',
  'gh-wrapper-audit-retention: rotate files=1',
  'warning: arbitrary native gh diagnostic',
].join('\\n') + '\\n';
if (${JSON.stringify(alwaysDiagnostics)} || scenario !== 'quiet') process.stderr.write(diagnostics);
if (scenario === 'malformed') { process.stdout.write('not-json\\n'); process.exit(0); }
if (scenario === 'nonzero') { process.stdout.write('{}\\n'); process.exit(7); }
if (scenario === 'empty-route') {
  if (joined.includes('/pulls/1') && !joined.includes('/files')) {
    process.stdout.write(JSON.stringify({ head: { sha: '${GH_SIGNAL_TEST_HEAD}', ref: 'topic' } }) + '\\n');
  } else if (joined.includes('/check-runs')) {
    process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }) + '\\n');
  } else if (joined.endsWith('/status')) {
    process.stdout.write(JSON.stringify({ statuses: [] }) + '\\n');
  } else {
    process.stdout.write('{}\\n');
  }
  process.exit(0);
}
if (scenario === 'watchdog') {
  if (joined.includes('/check-runs')) {
    process.stdout.write(JSON.stringify({ check_runs: [{
      id: 9001, name: 'ci', conclusion: 'failure', status: 'completed',
      details_url: 'https://github.com/acme/repo/actions/runs/123/job/456',
      completed_at: '2026-07-16T00:00:00Z', app: { id: 1 },
    }] }) + '\\n');
  } else if (joined.includes('/actions/runs/123/attempts/1/jobs')) {
    process.stdout.write(JSON.stringify({ jobs: [{
      id: 456, name: 'ci', conclusion: 'failure', started_at: '2026-07-16T00:00:00Z',
      steps: [{ number: 1, name: 'unit tests', conclusion: 'failure' }],
    }] }) + '\\n');
  } else if (joined.includes('/actions/runs/123/jobs')) {
    process.stdout.write(JSON.stringify({ jobs: [] }) + '\\n');
  } else if (joined.includes('/actions/runs/123')) {
    process.stdout.write(JSON.stringify({ head_sha: '${GH_SIGNAL_TEST_HEAD}', run_attempt: 1 }) + '\\n');
  } else if (args[0] === 'run' && args[1] === 'view') {
    process.stdout.write('ci\\tunit tests\\t2026-07-16T00:00:01Z\\tAssertionError: expected true\\n');
  } else {
    process.stdout.write('{}\\n');
  }
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list' && args.includes('--state')) {
  process.stdout.write(JSON.stringify([{ number: 849, headRefOid: '${GH_SIGNAL_TEST_HEAD}', baseRefName: 'main', headRefName: 'topic' }]) + '\\n');
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ number: 849, headRefOid: '${GH_SIGNAL_TEST_HEAD}', baseRefName: 'main', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefName: 'topic' }) + '\\n');
} else if (args[0] === 'pr' && args[1] === 'checks') {
  process.stdout.write('[]\\n');
} else if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) {
  process.stdout.write(JSON.stringify([{ number: 849, url: 'https://github.com/acme/repo/pull/849' }]) + '\\n');
} else if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ body: 'Issue body from authoritative read' }) + '\\n');
} else if (args[0] === 'api' && joined.includes('/branches/') && joined.endsWith('/protection')) {
  process.stdout.write(JSON.stringify({ required_status_checks: { contexts: [] } }) + '\\n');
} else if (args[0] === 'api' && joined.includes('/reviews')) {
  process.stdout.write('0\\n');
} else {
  process.stdout.write('{}\\n');
}
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}
