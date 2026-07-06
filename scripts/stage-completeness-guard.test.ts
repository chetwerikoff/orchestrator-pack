import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  parseCompetitiveWaiver,
} from './lib/stage-completeness-core.js';
import { runCli } from './stage-completeness-guard.js';

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/stage-completeness/worktree',
);
const draftsDir = path.join(repoRoot, 'docs/issues_drafts');

function loadDraft(name: string): string {
  return readFileSync(path.join(draftsDir, `${name}.md`), 'utf8');
}

function draftPath(name: string): string {
  return path.join(draftsDir, `${name}.md`);
}

function check(name: string) {
  return checkStageCompletenessGuard(loadDraft(name), {
    repoRoot,
    draftPath: draftPath(name),
  });
}

describe('stage-completeness missing competitive', () => {
  it('fails when competitive captures and waiver are both absent', () => {
    const result = check('missing-competitive');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing competitive stage/);
  });
});

describe('stage-completeness missing final', () => {
  it('fails when no architectural-final capture exists', () => {
    const result = check('missing-final');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing final architectural stage/);
  });
});

describe('stage-completeness lens ordering', () => {
  it('fails when architect-lens pass index is not after competitive anchor', () => {
    const result = check('lens-ordering');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/architect-lens stage out of order/);
  });

  it('uses competitive max over stale waiver anchor when both signals exist', () => {
    const result = check('both-signals');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/architect-lens stage out of order/);
  });
});

describe('stage-completeness final ordering', () => {
  it('fails when final architectural pass index is not after lens maximum', () => {
    const result = check('final-ordering');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/final architectural stage out of order/);
  });
});

describe('stage-completeness t1 t2 noop', () => {
  it('passes for T1 drafts without T3 captures', () => {
    const result = checkStageCompletenessGuard(loadDraft('t1-base'), {
      repoRoot,
      draftPath: draftPath('t1-base'),
    });
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });

  it('passes for T2 drafts without T3 captures', () => {
    const result = checkStageCompletenessGuard(loadDraft('t2-base'), {
      repoRoot,
      draftPath: draftPath('t2-base'),
    });
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });
});

describe('stage-completeness waiver path', () => {
  it('passes with a valid waiver and ordered lens/final captures', () => {
    const result = check('waiver-valid');
    expect(result.ok).toBe(true);
    expect(result.receipt?.competitiveAnchor).toBe(0);
  });

  it('fails when waiver record is malformed and competitive captures are absent', () => {
    const result = check('waiver-invalid');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing competitive stage/);
  });

  it('rejects waiver records with loose recorded-at or coerced after-pass values', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'stage-completeness-waiver-'));
    const cases = [
      {
        label: 'non-ISO recorded-at',
        body: JSON.stringify({
          reason: 'codex-substitution',
          'recorded-at': '2026-07-06',
          'after-pass': 0,
        }),
      },
      {
        label: 'null after-pass',
        body: JSON.stringify({
          reason: 'operator-waiver',
          'recorded-at': '2026-07-06T00:00:00.000Z',
          'after-pass': null,
        }),
      },
      {
        label: 'string after-pass',
        body: JSON.stringify({
          reason: 'operator-waiver',
          'recorded-at': '2026-07-06T00:00:00.000Z',
          'after-pass': '0',
        }),
      },
      {
        label: 'boolean after-pass',
        body: JSON.stringify({
          reason: 'operator-waiver',
          'recorded-at': '2026-07-06T00:00:00.000Z',
          'after-pass': false,
        }),
      },
    ];

    for (const testCase of cases) {
      writeFileSync(join(reviewDir, 'competitive-stage-waiver.json'), testCase.body, 'utf8');
      const parsed = parseCompetitiveWaiver(reviewDir);
      expect(parsed.waiver, testCase.label).toBeNull();
      expect(parsed.invalid, testCase.label).toBe(true);
    }
  });
});

describe('stage-completeness grandfather', () => {
  it('passes for the hardcoded grandfather review-dir basename without captures', () => {
    const result = check('206-ao-010-session-status-readers-migration');
    expect(result.ok).toBe(true);
    expect(result.receipt).toBeNull();
  });
});

describe('stage-completeness empty capture', () => {
  it('fails when a counted capture file is empty after trim', () => {
    const result = check('empty-capture');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/empty capture file/);
  });

  it('fails when a capture filename is not parseable as pass-NN-stage', () => {
    const result = check('malformed-filename');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unparseable capture filename: competitive\.capture\.txt/);
  });
});

describe('stage-completeness missing lens', () => {
  it('fails when architect-lens captures are absent', () => {
    const result = check('missing-lens');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing architect-lens stage/);
  });
});

describe('stage-completeness final ceiling', () => {
  it('fails when more than one final architectural pass exceeds the lens maximum', () => {
    const result = check('final-ceiling');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/final architectural stage ceiling exceeded/);
  });
});

describe('stage-completeness success receipt', () => {
  it('emits a machine-readable pass receipt naming tier=T3 and stage anchors', () => {
    const result = check('conforming');
    expect(result.ok).toBe(true);
    const message = formatStageCompletenessPassMessage(result);
    expect(message).toMatch(/tier=T3/);
    expect(message).toMatch(/competitive-anchor=1/);
    expect(message).toMatch(/lens-max=2/);
    expect(message).toMatch(/final-pass=3/);
    expect(
      runCli([
        'node',
        'stage-completeness-guard.ts',
        '--text-file',
        draftPath('conforming'),
        '--draft-path',
        draftPath('conforming'),
        '--repo-root',
        repoRoot,
      ]),
    ).toBe(0);
  });
});

describe('stage-completeness positive outcome', () => {
  it('refuses T3 drafts with only architectural-final captures at sync time', async () => {
    const { syncPublishIssueBody } = await import('./lib/publish-issue-body-sync.js');
    const draftContent = loadDraft('positive-outcome');
    const deps = {
      runGh() {
        throw new Error('gh should not run when stage-completeness guard fails');
      },
      writeBodyFile() {
        return '/tmp/issue-body.md';
      },
      emitAudit() {},
      validateTierGateGuard() {
        return { ok: true, message: 'tier-gate guard: PASS (test stub)' };
      },
    };
    const blocked = syncPublishIssueBody(deps, {
      mode: 'create',
      draftPath: draftPath('positive-outcome'),
      draftContent,
      repo: 'chetwerikoff/orchestrator-pack',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toContain('stage-completeness guard');
    }
  });
});
