/**
 * GitHub fleet governor mechanical CLI (Issue #585).
 */
import { printJson, readStdinJson, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';
import {
  acquireGithubGovernorAdmission,
  classifyGovernorTransportOutcome,
  readGovernorStateForFixture,
  releaseGithubGovernorAdmission,
  recordGithubGovernorObservedLimit,
  resolveCallerLane,
  resolveGovernorBudget,
  resolveGovernorStateDir,
} from '../scripts/lib/gh-governor.mjs';

export async function runGithubFleetGovernorCli(argv = process.argv.slice(2)) {
  const subcommand = argv[0] ?? '';
  const payload = readStdinJson();

  switch (subcommand) {
    case 'lane':
      return { lane: resolveCallerLane(process.env, payload.argv ?? []) };
    case 'budget':
      return resolveGovernorBudget(process.env);
    case 'acquire':
      return acquireGithubGovernorAdmission({
        env: process.env,
        argv: payload.argv ?? [],
        realGh: payload.realGh ?? 'gh',
        partitionKey: payload.partitionKey,
      });
    case 'release':
      releaseGithubGovernorAdmission({
        env: process.env,
        partitionKey: payload.partitionKey,
        emergency: payload.emergency === true,
        exitCode: payload.exitCode,
        stderr: payload.stderr,
        stdout: payload.stdout,
        headers: payload.headers,
      });
      return { released: true };
    case 'record-limit':
      return recordGithubGovernorObservedLimit({
        env: process.env,
        argv: payload.argv ?? [],
        realGh: payload.realGh ?? 'gh',
        partitionKey: payload.partitionKey,
        exitCode: payload.exitCode,
        stderr: payload.stderr,
        stdout: payload.stdout,
        headers: payload.headers,
      });
    case 'classify':
      return classifyGovernorTransportOutcome(payload);
    case 'read-state':
      return readGovernorStateForFixture(
        payload.stateDir ?? resolveGovernorStateDir(process.env),
        payload.partitionKey,
      );
    case 'scenario-evaluate': {
      const lane = resolveCallerLane(process.env, payload.argv ?? []);
      const acquire = acquireGithubGovernorAdmission({
        env: process.env,
        argv: payload.argv ?? [],
        realGh: payload.realGh ?? 'gh',
        partitionKey: payload.partitionKey,
      });
      if (!acquire.admitted) {
        return {
          outcome: 'deny',
          lane,
          reason: acquire.reason,
          audit: acquire.audit,
        };
      }
      if (payload.simulatedOutcome) {
        acquire.release({
          exitCode: payload.simulatedOutcome.exitCode,
          stderr: payload.simulatedOutcome.stderr,
          stdout: payload.simulatedOutcome.stdout,
          headers: payload.simulatedOutcome.headers,
        });
      } else {
        acquire.release();
      }
      return {
        outcome: acquire.emergency ? 'emergency-paced' : 'admit',
        lane,
        audit: acquire.audit,
      };
    }
    default:
      throw new Error(`unknown github-fleet-governor subcommand: ${subcommand || '(missing)'}`);
  }
}

runAsyncStdinJsonCliMain('github-fleet-governor.mjs', async () => runGithubFleetGovernorCli());
