import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  parseArchitectLensWaiver,
  parseCompetitiveWaiver,
} from './lib/stage-completeness-core.ts';
import { runCli } from './stage-completeness-guard.ts';

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

describe('stage-completeness missing architectural', () => {
  it('fails when competitive and lens exist but terminal architectural is absent', () => {
    const result = check('missing-architectural');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing terminal architectural stage/);
  });
});

describe('stage-completeness architectural ordering', () => {
  it('fails when only pre-lens architectural exists and no terminal GPT capture follows lens', () => {
    const result = check('architectural-ordering');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(
      /terminal GPT capture must be strictly after architect-lens|missing terminal architectural stage/,
    );
  });
});

describe('stage-completeness missing terminal architectural', () => {
  it('fails when no terminal architectural capture exists after lens', () => {
    const result = check('missing-final');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing terminal architectural stage/);
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

describe('stage-completeness terminal ordering', () => {
  it('fails when terminal architectural pass index is not after lens maximum', () => {
    const result = check('final-ordering');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(
      /terminal GPT capture must be strictly after architect-lens|missing terminal architectural stage/,
    );
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
  it('passes with a valid operator waiver and ordered architectural, lens, and final captures', () => {
    const result = check('waiver-valid');
    expect(result.ok).toBe(true);
    expect(result.receipt?.competitiveAnchor).toBe(0);
    expect(result.receipt?.lensMax).toBe(1);
    expect(result.receipt?.terminalPass).toBe(2);
  });

  it('rejects codex-substitution waiver for missing competitive stage credit', () => {
    const result = check('codex-substitution-waiver');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing competitive stage/);
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

  it('still parses historical codex-substitution waiver bytes without granting stage credit', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'stage-completeness-codex-waiver-'));
    writeFileSync(
      join(reviewDir, 'competitive-stage-waiver.json'),
      JSON.stringify({
        reason: 'codex-substitution',
        'recorded-at': '2026-07-06T00:00:00.000Z',
        'after-pass': 0,
      }),
      'utf8',
    );
    const parsed = parseCompetitiveWaiver(reviewDir);
    expect(parsed.waiver?.reason).toBe('codex-substitution');
    expect(parsed.invalid).toBe(false);
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

  it('tolerates malformed plain architectural capture filenames when a valid architectural pass exists', () => {
    const result = check('tolerated-architectural-filename');
    expect(result.ok).toBe(true);
    expect(result.receipt?.terminalPass).toBe(3);
  });
});

describe('stage-completeness missing lens', () => {
  it('fails when architect-lens captures are absent', () => {
    const result = check('missing-lens');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing architect-lens stage \(no capture and no valid claude-unavailable skip\)/);
  });
});

describe('stage-completeness terminal ceiling', () => {
  it('fails when more than one terminal architectural pass exceeds the lens maximum', () => {
    const result = check('final-ceiling');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/terminal architectural stage ceiling exceeded/);
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
    expect(message).toMatch(/terminal-pass=3/);
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

describe('stage-completeness historical architectural-final bytes', () => {
  it('passes when historical architectural-final captures are present but not required', () => {
    const reviewDir = path.join(draftsDir, '.review/conforming');
    writeFileSync(
      path.join(reviewDir, 'pass-04-architectural-final.capture.txt'),
      'historical final bytes\n',
      'utf8',
    );
    try {
      const result = check('conforming');
      expect(result.ok, result.errors.join('\n')).toBe(true);
      expect(result.receipt?.terminalPass).toBe(3);
    } finally {
      rmSync(path.join(reviewDir, 'pass-04-architectural-final.capture.txt'));
    }
  });
});


describe('stage-completeness claude-unavailable skip', () => {
  it('passes with the documented producer-facing claude-unavailable waiver shape', () => {
    const result = check('claude-skip-valid');
    expect(result.ok).toBe(true);
    expect(result.receipt?.lensMax).toBeNull();
    expect(result.receipt?.lensSkipAnchor).toBe(2);
    expect(result.receipt?.terminalPass).toBe(3);
    const message = formatStageCompletenessPassMessage(result);
    expect(message).toMatch(/lens-skip-anchor=2/);
    expect(message).toMatch(/terminal-pass=3/);
  });

  it('fails when claude skip record is malformed and no lens capture exists', () => {
    const result = check('claude-skip-malformed');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/invalid architect-lens skip record/);
    expect(result.errors.join(' ')).toMatch(/missing architect-lens stage/);
  });

  it('fails when a valid skip exists but terminal architectural is missing', () => {
    const result = check('claude-skip-missing-terminal');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing terminal architectural stage/);
  });

  it('fails when claude-unavailable skip anchor is not after the competitive anchor', () => {
    const result = check('claude-skip-ordering');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/claude-unavailable skip anchor out of order/);
  });

  it('fails when skip record coexists with an architectural-lens capture', () => {
    const result = check('claude-skip-coexist-lens');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/skip is not Claude provenance/);
  });

  it('rejects lens skip records with loose recorded-at or invalid unavailability kinds', () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'stage-completeness-lens-skip-'));
    const cases = [
      {
        label: 'non-ISO recorded-at',
        body: JSON.stringify({
          reason: 'claude-unavailable',
          'recorded-at': '2026-07-06',
          'after-pass': 1,
          unavailability: 'quota',
        }),
      },
      {
        label: 'impatience unavailability',
        body: JSON.stringify({
          reason: 'claude-unavailable',
          'recorded-at': '2026-07-06T00:00:00.000Z',
          'after-pass': 1,
          unavailability: 'impatience',
        }),
      },
      {
        label: 'missing unavailability',
        body: JSON.stringify({
          reason: 'claude-unavailable',
          'recorded-at': '2026-07-06T00:00:00.000Z',
          'after-pass': 1,
        }),
      },
    ];

    for (const testCase of cases) {
      writeFileSync(join(reviewDir, 'architect-lens-stage-waiver.json'), testCase.body, 'utf8');
      const parsed = parseArchitectLensWaiver(reviewDir);
      expect(parsed.waiver, testCase.label).toBeNull();
      expect(parsed.invalid, testCase.label).toBe(true);
    }
  });
});

describe('stage-completeness positive outcome', () => {
  it('refuses T3 drafts with only architectural-final captures at sync time', async () => {
    const { syncPublishIssueBody } = await import('./lib/publish-issue-body-sync.ts');
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
