from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


core = 'scripts/lib/tier-gate-core.ts'
replace_once(
    core,
    """export interface LegacyDemotionRevalidationRecord {
  schema: 'tier-demotion-revalidation/v1';
  eventId: string;
  candidateRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
}

export interface TierTransitionEvidence {""",
    """export interface LegacyDemotionRevalidationRecord {
  schema: 'tier-demotion-revalidation/v1';
  eventId: string;
  candidateRevision: string;
  beforeTier: Tier;
  afterTier: Tier;
}

export interface RetiredDemotionFenceEvidence {
  eventMatches: number;
  invalidEventMatches: number;
  revalidationMatches: number;
  invalidRevalidationMatches: number;
}

export interface RetiredDemotionCaptureInspection {
  events: LegacyDemotionEventRecord[];
  revalidations: LegacyDemotionRevalidationRecord[];
  fences: RetiredDemotionFenceEvidence;
}

export interface TierTransitionEvidence {""",
)
replace_once(
    core,
    """  captures?: Array<{ captureName: string; captureText: string }>;
  /** Filesystem-loaded evidence only: whether the path uses the Issue-number authority. */""",
    """  captures?: Array<{ captureName: string; captureText: string }>;
  /** Presence and validity of every retired-protocol fence match, including parser failures. */
  retiredDemotionFences?: RetiredDemotionFenceEvidence;
  /** Filesystem-loaded evidence only: whether the path uses the Issue-number authority. */""",
)
replace_once(
    core,
    """function parseFencedRecords<T>(text: string, regex: RegExp, parser: (value: unknown) => T | null): T[] {
  regex.lastIndex = 0;
  const records: T[] = [];
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    try {
      const record = parser(JSON.parse(match[1] ?? ''));
      if (record) records.push(record);
    } catch {
      // Malformed legacy evidence is represented by a missing required record and fails closed.
    }
  }
  return records;
}
""",
    """interface ParsedFencedRecords<T> {
  records: T[];
  totalMatches: number;
  invalidMatches: number;
}

function parseFencedRecords<T>(
  text: string,
  regex: RegExp,
  parser: (value: unknown) => T | null,
): ParsedFencedRecords<T> {
  regex.lastIndex = 0;
  const records: T[] = [];
  let totalMatches = 0;
  let invalidMatches = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    totalMatches += 1;
    try {
      const record = parser(JSON.parse(match[1] ?? ''));
      if (record) records.push(record);
      else invalidMatches += 1;
    } catch {
      invalidMatches += 1;
    }
  }
  return { records, totalMatches, invalidMatches };
}

export function inspectRetiredDemotionCapture(text: string): RetiredDemotionCaptureInspection {
  const events = parseFencedRecords(text, LEGACY_EVENT_RE, parseLegacyEvent);
  const revalidations = parseFencedRecords(text, LEGACY_REVALIDATION_RE, parseLegacyRevalidation);
  return {
    events: events.records,
    revalidations: revalidations.records,
    fences: {
      eventMatches: events.totalMatches,
      invalidEventMatches: events.invalidMatches,
      revalidationMatches: revalidations.totalMatches,
      invalidRevalidationMatches: revalidations.invalidMatches,
    },
  };
}
""",
)
replace_once(
    core,
    """  const events: TierTransitionEvidence['events'] = [];
  const revalidations: TierTransitionEvidence['revalidations'] = [];
  const captures: NonNullable<TierTransitionEvidence['captures']> = [];
  if (existsSync(layout.reviewDir)) {
    for (const captureName of readdirSync(layout.reviewDir).filter((name) => name.endsWith('.capture.txt')).sort()) {
      const captureText = readFileSync(join(layout.reviewDir, captureName), 'utf8');
      captures.push({ captureName, captureText });
      events.push(...parseFencedRecords(captureText, LEGACY_EVENT_RE, parseLegacyEvent)
        .map((record) => ({ record, captureName, captureText })));
      revalidations.push(...parseFencedRecords(captureText, LEGACY_REVALIDATION_RE, parseLegacyRevalidation)
        .map((record) => ({ record, captureName, captureText })));
    }
  }
""",
    """  const events: TierTransitionEvidence['events'] = [];
  const revalidations: TierTransitionEvidence['revalidations'] = [];
  const captures: NonNullable<TierTransitionEvidence['captures']> = [];
  const retiredDemotionFences: RetiredDemotionFenceEvidence = {
    eventMatches: 0,
    invalidEventMatches: 0,
    revalidationMatches: 0,
    invalidRevalidationMatches: 0,
  };
  if (existsSync(layout.reviewDir)) {
    for (const captureName of readdirSync(layout.reviewDir).filter((name) => name.endsWith('.capture.txt')).sort()) {
      const captureText = readFileSync(join(layout.reviewDir, captureName), 'utf8');
      captures.push({ captureName, captureText });
      const inspection = inspectRetiredDemotionCapture(captureText);
      retiredDemotionFences.eventMatches += inspection.fences.eventMatches;
      retiredDemotionFences.invalidEventMatches += inspection.fences.invalidEventMatches;
      retiredDemotionFences.revalidationMatches += inspection.fences.revalidationMatches;
      retiredDemotionFences.invalidRevalidationMatches += inspection.fences.invalidRevalidationMatches;
      events.push(...inspection.events.map((record) => ({ record, captureName, captureText })));
      revalidations.push(...inspection.revalidations.map((record) => ({ record, captureName, captureText })));
    }
  }
""",
)
replace_once(
    core,
    """      revalidations,
      captures,
      canonicalIssueWorkdir: layout.canonicalIssueWorkdir,""",
    """      revalidations,
      captures,
      retiredDemotionFences,
      canonicalIssueWorkdir: layout.canonicalIssueWorkdir,""",
)
replace_once(
    core,
    """function captureRevision(text: string): string | null {
""",
    """export function formatCaptureRevisionHeader(revision: string): string {
  const normalized = revision.toLowerCase();
  if (!REVISION_RE.test(normalized)) {
    throw new Error(`invalid immutable Issue revision: ${revision || '<empty>'}`);
  }
  return `issue_revision: ${normalized}\n`;
}

function captureRevision(text: string): string | null {
""",
)
replace_once(
    core,
    """function validateLegacyCompatibility(
  evidence: TierTransitionEvidence,
  currentIndex: number,
  errors: string[],
): void {
  if (evidence.events.length !== 1 || evidence.revalidations.length !== 1) {
    errors.push('tier compatibility: frozen identity requires exactly one completed event and revalidation');
    return;
  }
""",
    """function resolvedRetiredDemotionFences(evidence: TierTransitionEvidence): RetiredDemotionFenceEvidence {
  return evidence.retiredDemotionFences ?? {
    eventMatches: evidence.events.length,
    invalidEventMatches: 0,
    revalidationMatches: evidence.revalidations.length,
    invalidRevalidationMatches: 0,
  };
}

function validateLegacyCompatibility(
  evidence: TierTransitionEvidence,
  currentIndex: number,
  errors: string[],
): void {
  const retired = resolvedRetiredDemotionFences(evidence);
  if (
    retired.eventMatches !== 1
    || retired.revalidationMatches !== 1
    || retired.invalidEventMatches !== 0
    || retired.invalidRevalidationMatches !== 0
    || evidence.events.length !== 1
    || evidence.revalidations.length !== 1
  ) {
    errors.push('tier compatibility: frozen identity requires exactly one completed event and revalidation with no extra or malformed retired fences');
    return;
  }
""",
)
replace_once(
    core,
    """  if (evidence.events.length > 0 || evidence.revalidations.length > 0) {
    errors.push('tier correction: fresh progression cannot produce or consume retired demotion records');
  }

  const hasCorrectionAttempt""",
    """  const retired = resolvedRetiredDemotionFences(evidence);
  if (retired.eventMatches > 0 || retired.revalidationMatches > 0) {
    errors.push('tier correction: fresh progression cannot produce or consume retired demotion records');
  }
  for (const revision of evidence.revisions.slice(0, currentIndex + 1)) {
    if (revision.receipt?.legacyL4Status) {
      errors.push(`tier decision: fresh below-T3 receipt must emit l4Status not-applicable (${revision.revision})`);
    }
  }

  const hasCorrectionAttempt""",
)
replace_once(
    core,
    """    if (receipt?.legacyL4Status) {
      errors.push('tier correction: new below-T3 receipt must emit l4Status not-applicable');
    }
""",
    """""",
)

cli = 'scripts/tier-gate-guard.ts'
replace_once(
    cli,
    """  checkTierGateGuard,
  formatTierGatePassMessage,
  selectAuthoringReviewStages,""",
    """  checkTierGateGuard,
  formatCaptureRevisionHeader,
  formatTierGatePassMessage,
  selectAuthoringReviewStages,""",
)
replace_once(
    cli,
    """  explicitAdversarialWrapper: boolean;
  emitStagesJson: boolean;
}""",
    """  explicitAdversarialWrapper: boolean;
  emitStagesJson: boolean;
  captureRevision: string | null;
}""",
)
replace_once(
    cli,
    """    explicitAdversarialWrapper: false,
    emitStagesJson: false,
  };""",
    """    explicitAdversarialWrapper: false,
    emitStagesJson: false,
    captureRevision: null,
  };""",
)
replace_once(
    cli,
    """      case '--emit-stages-json':
        opts.emitStagesJson = true;
        return 'handled';
      default:""",
    """      case '--emit-stages-json':
        opts.emitStagesJson = true;
        return 'handled';
      case '--capture-revision':
        opts.captureRevision = String(args[++index] ?? '');
        return index;
      default:""",
)
replace_once(
    cli,
    """  if (!opts.textPath && opts.text == null) {
    process.stderr.write('tier-gate guard: --text-file <path> or --text <string> is required\n');
    return 2;
  }

  const text = opts.textPath ? readFileSync(opts.textPath, 'utf8') : String(opts.text);
""",
    """  if (opts.captureRevision !== null) {
    if (
      opts.textPath
      || opts.text !== null
      || opts.draftPath
      || opts.tier
      || opts.skipLine
      || opts.explicitAdversarialWrapper
      || opts.emitStagesJson
    ) {
      process.stderr.write('tier-gate guard: --capture-revision cannot be combined with guard options\n');
      return 2;
    }
    try {
      process.stdout.write(formatCaptureRevisionHeader(opts.captureRevision));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tier-gate guard: ${message}\n`);
      return 2;
    }
  }

  if (!opts.textPath && opts.text == null) {
    process.stderr.write('tier-gate guard: --text-file <path>, --text <string>, or --capture-revision <rNN> is required\n');
    return 2;
  }

  const text = opts.textPath ? readFileSync(opts.textPath, 'utf8') : String(opts.text);
""",
)

test = 'scripts/tier-gate-guard.test.ts'
replace_once(
    test,
    """  checkTierGateGuard,
  parseComplexityTierFence,
  parseDecisionReceipt,""",
    """  checkTierGateGuard,
  inspectRetiredDemotionCapture,
  parseComplexityTierFence,
  parseDecisionReceipt,""",
)
replace_once(
    test,
    """    revalidations: options.revalidations ?? [],
    captures: options.captures ?? [],
  };""",
    """    revalidations: options.revalidations ?? [],
    captures: options.captures ?? [],
    retiredDemotionFences: options.retiredDemotionFences,
  };""",
)
replace_once(
    test,
    """function run(text: string, transitionEvidence: TierTransitionEvidence, legacy: readonly string[] = []) {
  return checkTierGateGuard(text, {
    repoRoot: process.cwd(),
    transitionEvidence,
    completedLegacyDemotionIdentities: legacy,
  });
}

function correction(""",
    """function run(text: string, transitionEvidence: TierTransitionEvidence, legacy: readonly string[] = []) {
  return checkTierGateGuard(text, {
    repoRoot: process.cwd(),
    transitionEvidence,
    completedLegacyDemotionIdentities: legacy,
  });
}

function captureHeader(revision: string): string {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    expect(runCli(['node', 'tier-gate-guard.ts', '--capture-revision', revision])).toBe(0);
    expect(stderr).toEqual([]);
    return stdout.join('');
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function retiredCaptureOptions(captureText: string, captureName = 'pass-01-architectural.capture.txt') {
  const inspection = inspectRetiredDemotionCapture(captureText);
  return {
    events: inspection.events.map((record) => ({ record, captureName, captureText })),
    revalidations: inspection.revalidations.map((record) => ({ record, captureName, captureText })),
    retiredDemotionFences: inspection.fences,
    captures: [{ captureName, captureText }],
  };
}

function correction(""",
)
replace_once(
    test,
    """  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {""",
    """  it('rejects legacy clear on every fresh below-T3 receipt while preserving parser compatibility', () => {
    const first = draft('T2', 'T2');
    const legacyFirst = parseDecisionReceipt({
      schema: 'tier-gate-decision/v1', producer: 'cursor-flow-manager', revision: 'r01', tier: 'T2',
      rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear',
    });
    const firstErrors = run(first, evidence([
      { revision: 'r01', text: first, tier: 'T2', receipt: legacyFirst },
    ], { priorTier: 'T2' })).errors.join('\n');
    expect(firstErrors).toContain('fresh below-T3 receipt must emit l4Status not-applicable');

    const second = draft('T2', 'T2');
    const legacySecond = parseDecisionReceipt({
      schema: 'tier-gate-decision/v1', producer: 'cursor-flow-manager', revision: 'r02', tier: 'T2',
      rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear',
    });
    const secondErrors = run(second, evidence([
      { revision: 'r01', text: first, tier: 'T2', receipt: receipt('r01', 'T2') },
      { revision: 'r02', text: second, tier: 'T2', receipt: legacySecond },
    ], { priorTier: 'T2' })).errors.join('\n');
    expect(secondErrors).toContain('fresh below-T3 receipt must emit l4Status not-applicable');
  });

  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {""",
)
replace_once(
    test,
    """  it('accepts a capture bound to the corrected revision because the receipt existed first', () => {
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-architectural.capture.txt', captureText: 'issue_revision: r02\nNO_FINDINGS' }],
    });
    const result = run(fixture.current, fixture.transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
""",
    """  it('produces a deterministic capture header and accepts it after the corrected receipt', () => {
    const producedHeader = captureHeader('R02');
    expect(producedHeader).toBe('issue_revision: r02\n');
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-architectural.capture.txt', captureText: `${producedHeader}NO_FINDINGS` }],
    });
    const result = run(fixture.current, fixture.transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
""",
)
replace_once(
    test,
    """  it('rejects retired demotion fence fields for a fresh task', () => {
    const current = draft('T2', 'T3', { legacyFence: true });
    const transitionEvidence = evidence([
      { revision: 'r01', text: draft('T3', 'T3'), tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' }) },
    ]);
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion fence fields');
  });
""",
    """  it('rejects retired demotion fence fields for a fresh task', () => {
    const current = draft('T2', 'T3', { legacyFence: true });
    const transitionEvidence = evidence([
      { revision: 'r01', text: draft('T3', 'T3'), tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' }) },
    ]);
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion fence fields');
  });

  it('rejects malformed and former fresh-shape retired demotion capture output', () => {
    const current = draft('T2', 'T2');
    const samples = [
      '```tier-demotion-event\n{not-json}\n```',
      '```tier-demotion-event\n{"schema":"tier-demotion-event/v1","eventId":"new-1","kind":"new","sourceRevision":"r01","beforeTier":"T3","afterTier":"T2"}\n```',
      '```tier-demotion-revalidation\n{broken-json}\n```',
    ];
    for (const captureText of samples) {
      const transitionEvidence = evidence([
        { revision: 'r01', text: current, tier: 'T2', receipt: receipt('r01', 'T2') },
      ], { priorTier: 'T2', ...retiredCaptureOptions(captureText) });
      expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion records');
    }
  });
""",
)
replace_once(
    test,
    """  it('rejects a new identity, partial chain, and later candidate', () => {
    const freshIdentity = legacyFixture();
    expect(run(freshIdentity.current, freshIdentity.transitionEvidence).errors.join('\n')).toContain('compatibility intake');

    const partial = legacyFixture();
    partial.transitionEvidence.revalidations = [];
    expect(run(partial.current, partial.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('exactly one completed');

    const later = legacyFixture(true);
    expect(run(later.current, later.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('existing current lower-tier candidate');
  });
""",
    """  it('rejects a new identity, partial chain, and later candidate', () => {
    const freshIdentity = legacyFixture();
    expect(run(freshIdentity.current, freshIdentity.transitionEvidence).errors.join('\n')).toContain('compatibility intake');

    const partial = legacyFixture();
    partial.transitionEvidence.revalidations = [];
    expect(run(partial.current, partial.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('exactly one completed');

    const later = legacyFixture(true);
    expect(run(later.current, later.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('existing current lower-tier candidate');
  });

  it('rejects a valid compatibility chain with any appended malformed retired fence', () => {
    const validEvent = '```tier-demotion-event\n{"schema":"tier-demotion-event/v1","eventId":"old-1","kind":"compatibility","sourceRevision":"r01","beforeTier":"T3","afterTier":"T2"}\n```';
    const validRevalidation = '```tier-demotion-revalidation\n{"schema":"tier-demotion-revalidation/v1","eventId":"old-1","candidateRevision":"r02","beforeTier":"T3","afterTier":"T2"}\n```';
    for (const malformed of [
      '```tier-demotion-event\n{bad}\n```',
      '```tier-demotion-revalidation\n{bad}\n```',
    ]) {
      const fixture = legacyFixture();
      const captureText = `${validEvent}\n${validRevalidation}\n${malformed}`;
      const parsed = retiredCaptureOptions(captureText, 'pass-01-architectural-lens.capture.txt');
      fixture.transitionEvidence.events = parsed.events;
      fixture.transitionEvidence.revalidations = parsed.revalidations;
      fixture.transitionEvidence.retiredDemotionFences = parsed.retiredDemotionFences;
      fixture.transitionEvidence.captures = parsed.captures;
      expect(run(fixture.current, fixture.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('no extra or malformed retired fences');
    }
  });
""",
)

skill = '.claude/skills/create-issue-draft/SKILL.md'
replace_once(
    skill,
    """Save every response verbatim before normalization. `architectural-review`
findings use the same finding-disposition ledger; there is no second ledger.

### Normalized #975 ledger facts""",
    """Save every response verbatim before normalization. `architectural-review`
findings use the same finding-disposition ledger; there is no second ledger.

### Canonical capture producer

The flow-manager, not the reviewer, writes the immutable revision binding as the
first line of every new counted capture. Initialize the destination before
launching the Browser-GPT or Claude stage:

```bash
ISSUE_REVISION=rNN
CAPTURE="$REVIEW_DIR/pass-NN-<stage>.capture.txt"
node scripts/tier-gate-guard.ts --capture-revision "$ISSUE_REVISION" > "$CAPTURE"
# Append the exact terminal reviewer/Claude output verbatim to "$CAPTURE".
```

For Browser-GPT stages, redirect the canonical `chatgpt-browser-turn -- turn`
stdout with `>> "$CAPTURE"`; for Claude, append the producing CLI's exact stdout.
Never ask or trust the reviewer to echo `issue_revision`. The producer-owned
header is deterministic `issue_revision: rNN` evidence used by the tier guard;
new captures without it are malformed for correction chronology.

### Normalized #975 ledger facts""",
)

print('applied Issue #1142 follow-up review fixes')
