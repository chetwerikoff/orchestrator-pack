import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeCommentBody } from './create-issue-stage-record-marker.ts';
import type {
  GhInvocationResult,
  GhTransport,
  StageEventLogical,
  TrustedComment,
} from './create-issue-stage-record-types.ts';
import { STAGE_SCHEMA } from './create-issue-stage-record-types.ts';

export interface MockGhState {
  ownerLogin: string;
  comments: TrustedComment[];
  labels: Set<string>;
  issue: {
    title: string;
    body: string;
    labels: string[];
  };
  nextCommentId: number;
  failCreate?: boolean;
  failLabelSync?: boolean;
  ambiguousCreate?: boolean;
  pagesByRequest: Map<string, TrustedComment[]>;
}

export function createMockGhState(overrides: Partial<MockGhState> = {}): MockGhState {
  return {
    ownerLogin: 'chetwerikoff',
    comments: [],
    labels: new Set(),
    issue: {
      title: 'test issue',
      body: 'issue revision r01 body',
      labels: ['bug'],
    },
    nextCommentId: 1,
    pagesByRequest: new Map(),
    ...overrides,
  };
}

function pageKey(path: string, page: number, pageSize: number): string {
  return `${path}?page=${page}&per_page=${pageSize}`;
}

export function installCommentPages(
  state: MockGhState,
  repo: string,
  issueNumber: number,
  pages: TrustedComment[][],
  pageSize = 100,
): void {
  const path = `repos/${repo.split('/')[0]}/${repo.split('/')[1]}/issues/${issueNumber}/comments`;
  for (let index = 0; index < pages.length; index += 1) {
    state.pagesByRequest.set(pageKey(path, index + 1, pageSize), pages[index] ?? []);
  }
  state.pagesByRequest.set(pageKey(path, pages.length + 1, pageSize), []);
}

function readFormValue(argv: string[], key: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '-f' && typeof argv[index + 1] === 'string' && argv[index + 1]!.startsWith(`${key}=`)) {
      return argv[index + 1]!.slice(key.length + 1);
    }
  }
  return undefined;
}

export function createMockTransport(state: MockGhState): GhTransport {
  return {
    runGh(argv: string[]): GhInvocationResult {
      const command = argv[0];
      if (command !== 'gh') {
        return { exitCode: 1, stdout: '', stderr: 'invalid command' };
      }
      const sub = argv[1];
      if (sub === 'api') {
        const requestPath = argv[2] ?? '';
        const [path, query = ''] = requestPath.split('?', 2);
        const owner = path.match(/^repos\/([^/]+)\/([^/]+)/);
        if (path.endsWith('/comments') && argv.includes('-f') && readFormValue(argv, 'body')) {
          if (state.failCreate) {
            return { exitCode: 1, stdout: '', stderr: 'create failed' };
          }
          const body = readFormValue(argv, 'body') ?? '';
          if (state.ambiguousCreate) {
            return { exitCode: 0, stdout: '{}', stderr: '' };
          }
          const comment: TrustedComment = {
            id: state.nextCommentId,
            body,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            userLogin: state.ownerLogin,
            authorAssociation: 'OWNER',
          };
          state.nextCommentId += 1;
          state.comments.push(comment);
          return { exitCode: 0, stdout: JSON.stringify({ id: comment.id }), stderr: '' };
        }
        if (path.endsWith('/comments') && !argv.includes('-f') && query) {
          const params = new URLSearchParams(query);
          const page = Number(params.get('page') ?? '1');
          const perPage = Number(params.get('per_page') ?? '100');
          const key = pageKey(path, page, perPage);
          const pageItems = state.pagesByRequest.get(key);
          if (!pageItems) {
            const start = (page - 1) * perPage;
            const slice = state.comments.slice(start, start + perPage).map((comment) => ({
              id: comment.id,
              body: comment.body,
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              user: { login: comment.userLogin },
              author_association: comment.authorAssociation,
            }));
            return { exitCode: 0, stdout: JSON.stringify(slice), stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify(pageItems.map((comment) => ({
              id: comment.id,
              body: comment.body,
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              user: { login: comment.userLogin },
              author_association: comment.authorAssociation,
            }))),
            stderr: '',
          };
        }
        if (owner && path === `repos/${owner[1]}/${owner[2]}` && argv.includes('--jq')) {
          return { exitCode: 0, stdout: `${state.ownerLogin}\n`, stderr: '' };
        }
        if (path.includes('/issues/') && argv.includes('--jq')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: state.issue.title,
              body: state.issue.body,
              labels: state.issue.labels,
            }),
            stderr: '',
          };
        }
        if (path.includes('/issues/') && argv.includes('-X') && argv.includes('PATCH')) {
          if (state.failLabelSync) {
            return { exitCode: 1, stdout: '', stderr: 'label sync failed' };
          }
          const labels = argv
            .filter((argument) => argument.startsWith('labels[]='))
            .map((argument) => argument.slice('labels[]='.length));
          state.issue.labels = labels;
          return { exitCode: 0, stdout: '{}', stderr: '' };
        }
        if (path.startsWith('repos/') && path.includes('/labels/')) {
          const label = decodeURIComponent(path.split('/labels/')[1] ?? '');
          if (state.labels.has(label)) return { exitCode: 0, stdout: '{}', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        if (path.startsWith('repos/') && path.endsWith('/labels')) {
          const name = argv[argv.indexOf('-f') + 1]?.replace(/^name=/, '') ?? '';
          state.labels.add(name);
          return { exitCode: 0, stdout: '{}', stderr: '' };
        }
      }
      return { exitCode: 1, stdout: '', stderr: `unhandled ${argv.join(' ')}` };
    },
  };
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opk-1152-'));
  return dir;
}

export function sampleStageReceipt(cycleId: string) {
  const logical: StageEventLogical = {
    schema: STAGE_SCHEMA,
    'event-key': `${cycleId}:competitive:attempt-1`,
    'cycle-id': cycleId,
    stage: 'competitive',
    tier: 'T3',
    'source-revision': 'r01',
    'stage-attempt-id': 'attempt-1',
    'policy-version': 'triple-source/v1',
    'settled-outcome': 'complete',
    'source-count': 3,
    'required-source-count': 3,
    'producer-evidence': 'not-applicable',
    'tier-transition': 'none',
  };
  return {
    tier: 'T3',
    stage: 'competitive',
    cycleId,
    stageAttemptId: 'attempt-1',
    policyVersion: 'triple-source/v1',
    sourceRevision: 'r01',
    outcome: 'complete',
    reviewerCardinality: 3,
    completedSourceCount: 3,
    producerEvidence: 'not-applicable',
    tierTransition: 'none',
    cycleBinding: { cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
    markerBody: serializeCommentBody(logical),
  };
}
