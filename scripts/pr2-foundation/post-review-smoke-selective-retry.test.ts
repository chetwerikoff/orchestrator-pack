// @vitest-ci-lane light
// @vitest-pre-topology-seconds 10

import { describe, expect, it } from 'vitest';
import {
  formatSmokeReportComment,
  planWorkerSmokeSelectiveRetry,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from '../lib/worker-smoke-core.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1924;
const PR = 1930;
const ACTOR = 'pack-publisher';
const ANCESTOR = 'a'.repeat(40);
const FORK = 'b'.repeat(40);
const CURRENT = 'c'.repeat(40);
const ACTION = 'S1 action';
const EXPECTED = 'S1 expected';
const ISSUE_BODY = `\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`smoke-test-plan
scenarios:
  - action: ${ACTION} | expected: ${EXPECTED}
\`\`\``;

function report(headSha: string): SmokeReport {
  return {
    result: 'PASS',
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    scenarios: [{ action: ACTION, expected: EXPECTED, observed: `${headSha}: pass`, outcome: 'pass' }],
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: `selective-${headSha[0]}`,
  };
}

function comment(id: number, smoke: SmokeReport): WorkerSmokeCommentRecord {
  const createdAt = new Date(Date.UTC(2026, 8, 16, 1, 0, 0, id)).toISOString();
  return {
    id,
    body: formatSmokeReportComment(smoke),
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: ACTOR },
  };
}

function target(): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: REPO,
    issueNumber: ISSUE,
    prNumber: PR,
    headSha: CURRENT,
    resolvedIssueNumber: ISSUE,
    resolvedPrNumber: PR,
    liveHeadSha: CURRENT,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

describe('Issue #1924 selective retry lineage continuation', () => {
  it('keeps a reusable ancestor when a later canonical comment belongs to a non-ancestor fork', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: ISSUE_BODY,
      prBody: '',
      comments: [comment(1, report(ANCESTOR)), comment(2, report(FORK))],
      target: target(),
      isAncestor: (ancestorSha, descendantSha) =>
        descendantSha === CURRENT && ancestorSha === ANCESTOR,
    });

    expect(selection.fallbackReason).toBeUndefined();
    expect(selection.attemptPlan.scenarios).toEqual([]);
    expect(selection.carried).toHaveLength(1);
    expect(selection.carried[0]).toMatchObject({ sourceHeadSha: ANCESTOR, sourceCommentId: 1 });
  });
});
