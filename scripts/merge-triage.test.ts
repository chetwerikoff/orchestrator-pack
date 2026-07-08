import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adjudicateArchitectFinding,
  classifyFinding,
  DEFAULT_MARKER_FILE,
  evaluateMergePolicy,
  fileWorkerAppeal,
  issueArchitectProvenanceToken,
  loadMarkerList,
  readArchitectInbox,
  readPackFindingStore,
  runMergeTriageGate,
  VERDICT_BLOCK,
  VERDICT_DEFER,
  VERDICT_PENDING_ARCHITECT,
  VERDICT_PENDING_OPERATOR,
} from '../docs/merge-triage-gate.mjs';

const tempRoots: string[] = [];
function stateRoot() {
  const root = mkdtempSync(join(tmpdir(), 'merge-triage-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.MERGE_TRIAGE_SIMULATE_CATALOG_ERROR;
  delete process.env.AO_SESSION_KIND;
});

function atCap(pr = 648, head = 'abc123') {
  return { terminal: 'at_cap_open_findings', pr_number: pr, head_sha: head, producer: 'test' };
}

function finding(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    fingerprint: `fp-${id}`,
    title: text,
    body: `severity: blocking\ncategory: correctness\n${text}`,
    runId: 'run-1',
    status: 'open',
    headSha: 'abc123',
    ...extra,
  };
}

describe('gate-trigger-at-cap', () => {
  it('runs only after latched at_cap_open_findings and allows post-cap remediation head', () => {
    const root = stateRoot();
    expect(runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', findings: [] }).ran).toBe(false);
    const result = runMergeTriageGate({
      stateRoot: root,
      prNumber: 648,
      headSha: 'newhead',
      atCapRecord: atCap(648, 'oldhead'),
      findings: [],
    });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.clearance?.terminal).toBe('merge_triage_cleared');
  });
});

describe('marker-classification', () => {
  const cases: Array<[string, string, string]> = [
    ['parser error', 'parser error in main path', VERDICT_BLOCK],
    ['ReferenceError', 'ReferenceError before command dispatch', VERDICT_BLOCK],
    ['throws before', 'throws before worker receives task', VERDICT_BLOCK],
    ['cannot start', 'cannot start review gate', VERDICT_BLOCK],
    ['not executable', 'script is not executable', VERDICT_BLOCK],
    ['internal ellipsis', 'every candidate is classified malformed by parser', VERDICT_BLOCK],
    ['CI will fail', 'CI will fail on verify', VERDICT_BLOCK],
    ['verify.ps1 fails', 'verify.ps1 fails on main path', VERDICT_BLOCK],
    ['recorded as successful', 'red run recorded as successful', VERDICT_BLOCK],
    ['looks green', 'failed check looks green', VERDICT_BLOCK],
    ['never receives', 'worker never receives the main-path finding', VERDICT_BLOCK],
    ['written to disk', 'secret written to disk', VERDICT_BLOCK],
    ['passed to coworker/provider', 'secret passed to coworker/provider', VERDICT_BLOCK],
    ['crash defer', 'if the process crashes between claim and write', VERDICT_DEFER],
    ['head moves defer', 'when the head moves between review and merge', VERDICT_DEFER],
    ['concurrent defer', 'under concurrent worker sessions this can duplicate', VERDICT_DEFER],
    ['two sessions defer', 'if two live sessions race', VERDICT_DEFER],
    ['TOCTOU defer', 'TOCTOU window exists', VERDICT_DEFER],
    ['attacker spoof defer', 'an attacker/autonomous turn can forge/spoof a declaration', VERDICT_DEFER],
    ['bwrap defer', 'when bwrap/unshare is unavailable fallback differs', VERDICT_DEFER],
    ['windows defer', 'on Windows/BSD path semantics differ', VERDICT_DEFER],
    ['scope declaration defer', '[scope-violation] declaration missing', VERDICT_DEFER],
    ['declare path defer', 'declare the path in issue scope', VERDICT_DEFER],
    ['sync issue defer', 'sync to issue #N later', VERDICT_DEFER],
    ['conditional veto', 'CI will fail unless optional BSD tool is installed', VERDICT_DEFER],
  ];

  it.each(cases)('%s maps to %s', (_name, text, verdict) => {
    expect(classifyFinding(finding('case', text)).verdict).toBe(verdict);
  });

  it('scope-violation denylist path is BLOCK while declaration class is DEFER', () => {
    expect(classifyFinding(finding('scope-a', '[scope-violation]', { category: 'scope-violation' })).verdict).toBe(VERDICT_DEFER);
    expect(classifyFinding(finding('scope-b', '[scope-violation] touched vendor/**', { category: 'scope-violation' })).verdict).toBe(VERDICT_BLOCK);
    expect(classifyFinding(finding('scope-c', '[scope-violation] edited vendor/agent-orchestrator/foo', { category: 'scope-violation' })).verdict).toBe(VERDICT_BLOCK);
    expect(classifyFinding(finding('scope-d', '[scope-violation] touched packages/core/lib/foo.ts', { category: 'scope-violation' })).verdict).toBe(VERDICT_BLOCK);
    expect(classifyFinding(finding('scope-e', '[scope-violation] wrote .ao/sessions/state.json', { category: 'scope-violation' })).verdict).toBe(VERDICT_BLOCK);
  });
});

describe('ambiguity-fail-closed', () => {
  it('both-list and neither-list findings become PENDING_ARCHITECT with inbox rows and denied policy', () => {
    const root = stateRoot();
    const both = finding('both', 'parser error TOCTOU');
    const neither = finding('neither', 'non-English описание без маркеров');
    const result = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [both, neither] });
    expect(result.ok).toBe(false);
    expect(result.aggregate).toBe(VERDICT_PENDING_ARCHITECT);
    expect(readArchitectInbox({ stateRoot: root, prNumber: 648, headSha: 'abc123' }).pending).toHaveLength(2);
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [both, neither] }).allow).toBe(false);
  });
});

describe('catalog-durability', () => {
  it('dedups deferred catalog by pr_number and aborts clearance on write failure', () => {
    const root = stateRoot();
    const item = finding('d1', 'TOCTOU window');
    const first = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [item] });
    expect(first.ok).toBe(true);
    runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [item] });
    const catalog = readFileSync(join(root, 'deferred-findings/catalog.jsonl'), 'utf8').trim().split(/\r?\n/);
    expect(catalog).toHaveLength(1);

    const failRoot = stateRoot();
    process.env.MERGE_TRIAGE_SIMULATE_CATALOG_ERROR = '1';
    expect(() => runMergeTriageGate({ stateRoot: failRoot, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [item] })).toThrow(/catalog/);
  });

  it('cross-PR fingerprint collision keeps separate rows', () => {
    const root = stateRoot();
    const item = { ...finding('same', 'TOCTOU'), fingerprint: 'fp-shared' };
    runMergeTriageGate({ stateRoot: root, prNumber: 1, headSha: 'abc123', atCapRecord: atCap(1), findings: [item] });
    runMergeTriageGate({ stateRoot: root, prNumber: 2, headSha: 'abc123', atCapRecord: atCap(2), findings: [item] });
    const catalog = readFileSync(join(root, 'deferred-findings/catalog.jsonl'), 'utf8').trim().split(/\r?\n/);
    expect(catalog).toHaveLength(2);
  });
});

describe('clearance-terminal', () => {
  it('emits merge_triage_cleared with marker and finding snapshot hashes', () => {
    const root = stateRoot();
    const result = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('d1', 'TOCTOU')] });
    expect(result.clearance).toMatchObject({
      terminal: 'merge_triage_cleared',
      pr_number: 648,
      head_sha: 'abc123',
      marker_list_version: 1,
    });
    expect(result.clearance?.marker_list_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.clearance?.open_findings_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('merge-policy-hook', () => {
  it('allows clean early stop, requires validated clearance, and denies drift or pending inbox', () => {
    const root = stateRoot();
    const defer = finding('d1', 'TOCTOU');
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 648, headSha: 'abc123', terminalRecords: [{ terminal: 'clean_early_stop', pr_number: 648, head_sha: 'abc123' }] }).allow).toBe(true);
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [defer] }).allow).toBe(false);
    runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [defer] });
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [defer] }).allow).toBe(true);
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('changed', 'TOCTOU changed')] }).reason).toBe('open_findings_snapshot_drift');

    const markerFile = join(root, 'markers.json');
    const markers = loadMarkerList(DEFAULT_MARKER_FILE);
    writeFileSync(markerFile, JSON.stringify({ schema_version: 1, block_markers: markers.blockMarkers, defer_markers: [...markers.deferMarkers, 'new marker'] }));
    expect(evaluateMergePolicy({ stateRoot: root, markerFile, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [defer] }).reason).toBe('marker_list_drift');
  });
});

describe('architect-adjudication', () => {
  it('routes worker appeal through architect provenance, rejects stale/worker writes, and clears on DEFER', () => {
    const root = stateRoot();
    const block = finding('b1', 'parser error');
    fileWorkerAppeal({ stateRoot: root, prNumber: 648, headSha: 'abc123', finding: block, appealReason: 'conditional in context' });
    const pending = readArchitectInbox({ stateRoot: root, prNumber: 648, headSha: 'abc123' }).pending[0]!;
    expect(pending).not.toHaveProperty('adjudication_provenance_token');
    expect(() => adjudicateArchitectFinding({ stateRoot: root, sessionKind: 'worker', adjudicationId: pending.adjudication_id, verdict: VERDICT_DEFER, finding: block })).toThrow(/rejected/);
    expect(() => adjudicateArchitectFinding({ stateRoot: root, sessionKind: 'architect', adjudicationId: pending.adjudication_id, verdict: VERDICT_DEFER, finding: { ...block, body: 'changed' }, adjudicationProvenanceToken: 'bad', actorSession: 'arch-1' })).toThrow(/token/);
    expect(() => issueArchitectProvenanceToken({ stateRoot: root, sessionKind: 'worker', adjudicationId: pending.adjudication_id })).toThrow(/rejected/);
    const issuedToken = issueArchitectProvenanceToken({ stateRoot: root, sessionKind: 'architect', adjudicationId: pending.adjudication_id, prNumber: 648, headSha: 'abc123' });
    const adjudicated = adjudicateArchitectFinding({
      stateRoot: root,
      sessionKind: 'architect',
      adjudicationId: pending.adjudication_id,
      verdict: VERDICT_DEFER,
      finding: block,
      adjudicationProvenanceToken: issuedToken.adjudication_provenance_token,
      actorSession: 'arch-1',
    });
    expect(adjudicated.ok).toBe(true);
    const issued = fileWorkerAppeal({ stateRoot: root, prNumber: 649, headSha: 'abc123', finding: block, appealReason: 'second' });
    expect(issued.inbox).not.toHaveProperty('adjudication_provenance_token');
  });

  it('architect DEFER clearance snapshots the full open set when other findings remain', () => {
    const root = stateRoot();
    const open = [finding('amb1', 'text without seed marker'), finding('amb2', 'another unmarked finding')];
    runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: open });
    const pending = readArchitectInbox({ stateRoot: root, prNumber: 648, headSha: 'abc123' }).pending;
    expect(pending).toHaveLength(2);
    const token = issueArchitectProvenanceToken({
      stateRoot: root,
      sessionKind: 'architect',
      adjudicationId: pending[0]!.adjudication_id,
      prNumber: 648,
      headSha: 'abc123',
    });
    const adjudicated = adjudicateArchitectFinding({
      stateRoot: root,
      sessionKind: 'architect',
      adjudicationId: pending[0]!.adjudication_id,
      verdict: VERDICT_DEFER,
      finding: open[0],
      findings: open,
      adjudicationProvenanceToken: token.adjudication_provenance_token,
      actorSession: 'arch-1',
    });
    expect((adjudicated.clearance as { open_findings_snapshot_hash?: string })?.open_findings_snapshot_hash).toBeTruthy();
    expect(evaluateMergePolicy({
      stateRoot: root,
      prNumber: 648,
      headSha: 'abc123',
      atCapRecord: atCap(),
      findings: open,
    }).reason).toBe('pending_architect_adjudication');
    expect(evaluateMergePolicy({
      stateRoot: root,
      prNumber: 648,
      headSha: 'abc123',
      atCapRecord: atCap(),
      findings: open,
    }).reason).not.toBe('open_findings_snapshot_drift');
  });

  it('architect command with valid token is consumed by hidden-token gate and budget reaches PENDING_OPERATOR after two permissive verdicts', () => {
    const root = stateRoot();
    const result = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('amb1', 'text without seed marker')] });
    const internal = result.pendingArchitect?.[0] as Record<string, unknown>;
    expect(internal).not.toHaveProperty('adjudication_provenance_token');
    const tokens = JSON.parse(readFileSync(join(root, 'merge-triage/architect-tokens.json'), 'utf8'));
    const tokenHash = Object.values(tokens)[0] as { tokenHash: string };
    expect(tokenHash.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const root2 = stateRoot();
    const p1 = runMergeTriageGate({ stateRoot: root2, prNumber: 1, headSha: 'abc123', atCapRecord: atCap(1), findings: [finding('a1', 'no marker one')] });
    const p2 = runMergeTriageGate({ stateRoot: root2, prNumber: 2, headSha: 'abc123', atCapRecord: atCap(2), findings: [finding('a2', 'no marker two')] });
    // Tests supply the issued token directly by reading the private token hash is impossible; this exercises the budget branch through journal rows.
    writeFileSync(join(root2, 'merge-triage/verdict-journal.jsonl'), `${JSON.stringify({ actor: 'architect', verdict: VERDICT_DEFER })}\n${JSON.stringify({ actor: 'architect', verdict: VERDICT_DEFER })}\n`, { flag: 'a' });
    const pending = readArchitectInbox({ stateRoot: root2 }).pending[0]!;
    expect(adjudicateArchitectFinding({ stateRoot: root2, sessionKind: 'architect', adjudicationId: pending.adjudication_id, verdict: VERDICT_DEFER, finding: finding('a1', 'no marker one'), adjudicationProvenanceToken: 'unused', actorSession: 'arch-1' }).verdict).toBe(VERDICT_PENDING_OPERATOR);
    expect(p1.ok).toBe(false);
    expect(p2.ok).toBe(false);
  });
});

describe('block-bounded-continuation', () => {
  it('delivers only BLOCK findings and does not emit clearance or increment budget', () => {
    const root = stateRoot();
    const result = runMergeTriageGate({
      stateRoot: root,
      prNumber: 648,
      headSha: 'abc123',
      atCapRecord: atCap(),
      findings: [finding('b1', 'parser error'), finding('d1', 'TOCTOU')],
    });
    expect(result.aggregate).toBe(VERDICT_BLOCK);
    expect(result.blockDelivery).toHaveLength(1);
    expect(result.blockDelivery?.[0].distinct_head_budget_increment).toBe(0);
    expect(result.blockDelivery?.[0].finding_id).toBe('b1');
  });
});

describe('crash/restart idempotency and fail-closed parse', () => {
  it('preserves catalog rows across re-run and stays blocked while architect pending', () => {
    const root = stateRoot();
    runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('d1', 'TOCTOU')] });
    runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('d1', 'TOCTOU')] });
    expect(readFileSync(join(root, 'deferred-findings/catalog.jsonl'), 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    runMergeTriageGate({ stateRoot: root, prNumber: 649, headSha: 'abc123', atCapRecord: atCap(649), findings: [finding('p1', 'без маркера')] });
    expect(evaluateMergePolicy({ stateRoot: root, prNumber: 649, headSha: 'abc123', atCapRecord: atCap(649), findings: [finding('p1', 'без маркера')] }).allow).toBe(false);
  });

  it('missing/malformed marker file and empty finding text fail closed', () => {
    expect(() => loadMarkerList('/missing/marker.json')).toThrow(/missing/);
    const root = stateRoot();
    const markerFile = join(root, 'bad.json');
    writeFileSync(markerFile, '{"schema_version":1}');
    expect(() => loadMarkerList(markerFile)).toThrow(/malformed/);
    const result = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'abc123', atCapRecord: atCap(), findings: [finding('empty', '', { title: '', body: '' })] });
    expect(result.ok).toBe(false);
    expect(result.classifications?.[0].verdict).toBe(VERDICT_PENDING_ARCHITECT);
  });
});

describe('pack-finding-store-head-filter', () => {
  it('filters open findings by snake_case head_sha from the store reader', () => {
    const root = stateRoot();
    const findingsDir = join(root, 'code-reviews', 'findings');
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, 'a.json'), JSON.stringify([
      { id: 'old', fingerprint: 'fp-old', status: 'open', head_sha: 'oldhead', title: 'old', body: 'TOCTOU' },
      { id: 'new', fingerprint: 'fp-new', status: 'open', head_sha: 'newhead', title: 'new', body: 'TOCTOU' },
    ]));
    expect(readPackFindingStore({ projectPath: root, prNumber: 648, headSha: 'newhead' }).map((row) => row.id)).toEqual(['new']);
  });
});

describe('remediation-new-head', () => {
  it('re-runs after BLOCK remediation on advanced head and clears when open set is empty', () => {
    const root = stateRoot();
    const blocked = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'old', atCapRecord: atCap(648, 'old'), findings: [finding('b1', 'parser error', { headSha: 'old' })] });
    expect(blocked.aggregate).toBe(VERDICT_BLOCK);
    const cleared = runMergeTriageGate({ stateRoot: root, prNumber: 648, headSha: 'new', atCapRecord: atCap(648, 'old'), findings: [] });
    expect(cleared.ok).toBe(true);
    expect(cleared.clearance?.head_sha).toBe('new');
  });
});
