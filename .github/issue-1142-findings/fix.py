from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


# 1. Remove the contradictory restart-from-intake block and bind correction history
# to the canonical Issue-number workdir.
replace_once(
    'docs/tiering.md',
    """**Browser outage.** Required GPT work stays incomplete. No engine substitution.\n\n**In-flight cycles.** Continue from the canonical Issue-bound capture history;\nrestarting a local cycle never reopens intake correction authority.\n\n**Browser outage.** Required GPT work stays incomplete. No engine substitution.\n\n**In-flight cycles.** Restart the fixed per-tier sequence from intake; do not infer\nhistorical provenance to skip stages.\n""",
    """**Browser outage.** Required GPT work stays incomplete. No engine substitution.\n\n**In-flight cycles.** Continue from the canonical Issue-bound capture history;\nrestarting a local cycle never reopens intake correction authority.\n""",
)
replace_once(
    'docs/tiering.md',
    """The Issue identity owns one free correction window. It opens after intake and\ncloses when the first immutable capture exists for any reviewer stage selected by\n`selectAuthoringReviewStages`. Before closure, the flow-manager may lower the\n""",
    """The Issue identity owns one free correction window. Its authority is the\ncanonical `~/.local/state/create-issue-draft/.review/<N>/` review history and\n`~/.local/state/create-issue-draft/<N>/` immutable revision history, both keyed by\nIssue number rather than a mutable slug. The review authority lives outside every\ncycle/workdir, so starting or losing a workdir cannot hide an earlier capture.\nLegacy slug-keyed workdirs remain readable for already-fixed progression but\ncannot authorize an intake correction. The window opens after intake and closes when the first immutable capture exists for any\nreviewer stage selected by `selectAuthoringReviewStages`. Before closure, the\nflow-manager may lower the\n""",
)

# 2. Make the create-flow workdir and review history Issue-number bound.
replace_once(
    '.claude/skills/create-issue-draft/SKILL.md',
    """Task identity is `<N>-<slug>`. Create:\n\n```text\n~/.local/state/create-issue-draft/<N>-<slug>/       # $WORKDIR\n  docs/issues_drafts/<N>-<slug>.md                  # $ANCHOR\n  docs/issues_drafts/.review/<N>-<slug>/            # $REVIEW_DIR\n  r01/ r02/ …                                       # immutable pulled revisions\n```\n\nNo repository support files are copied into `$WORKDIR`. Repository-owned guards\n""",
    """Task identity is the immutable GitHub Issue number `<N>`; the slug is\ndisplay-only and may change without creating another correction boundary. Create:\n\n```text\n~/.local/state/create-issue-draft/<N>/              # $WORKDIR\n  docs/issues_drafts/<N>-<slug>.md                  # $ANCHOR\n  r01/ r02/ …                                       # immutable pulled revisions\n~/.local/state/create-issue-draft/.review/<N>/      # $REVIEW_DIR\n```\n\nThe numeric workdir and the review authority outside every workdir form the one\nIssue-bound history. Starting or losing a cycle/workdir does not hide the shared\nintake/capture history. A legacy `<N>-<slug>` workdir is read-compatible for\nalready-fixed progression but cannot exercise intake-correction authority;\ncontinue or migrate through the canonical numeric workdir instead of opening\nanother local cycle.\n\nNo repository support files are copied into `$WORKDIR`. Repository-owned guards\n""",
)
replace_once(
    '.claude/skills/create-issue-draft/SKILL.md',
    """WORKDIR=\"$HOME/.local/state/create-issue-draft/<N>-<slug>\"\nANCHOR=\"$WORKDIR/docs/issues_drafts/<N>-<slug>.md\"\nmkdir -p \"$(dirname \"$ANCHOR\")\" \"$WORKDIR/rNN\" \"$WORKDIR/docs/issues_drafts/.review/<N>-<slug>\"\n""",
    """WORKDIR=\"$HOME/.local/state/create-issue-draft/<N>\"\nREVIEW_DIR=\"$HOME/.local/state/create-issue-draft/.review/<N>\"\nANCHOR=\"$WORKDIR/docs/issues_drafts/<N>-<slug>.md\"\nmkdir -p \"$(dirname \"$ANCHOR\")\" \"$WORKDIR/rNN\" \"$REVIEW_DIR\"\n""",
)
replace_once(
    '.claude/skills/create-issue-draft/SKILL.md',
    """Before the first tier decision, record `$REVIEW_DIR/tier-intake.json` as\n`tier-intake/v1` with exact task identity, `kind: fresh`, intake prior,\n""",
    """Before the first tier decision, record `$REVIEW_DIR/tier-intake.json` as\n`tier-intake/v1` with exact numeric Issue task identity, `kind: fresh`, intake prior,\n""",
)

# 3. Fix stage selection, derive capture closure from it, make filesystem loading
# Issue-number bound, and reject correction fields on the first receipt.
replace_once(
    'scripts/lib/tier-gate-core.ts',
    "import { existsSync, readdirSync, readFileSync } from 'node:fs';\n",
    "import { existsSync, readdirSync, readFileSync } from 'node:fs';\nimport { homedir } from 'node:os';\n",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """  } else if (effectiveTier === 'T2') {\n    authoring.push('light-design-analysis');\n    review.push('architectural');\n    if (input.explicitAdversarialWrapper) review.unshift('competitive-adversarial');\n  } else if (effectiveTier === 'T3') {\n""",
    """  } else if (effectiveTier === 'T2') {\n    authoring.push('light-design-analysis');\n    review.push('architectural');\n  } else if (effectiveTier === 'T3') {\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """function deriveWorkdir(draftPath: string): { workdir: string; stem: string; reviewDir: string } | null {\n  const normalized = resolve(draftPath);\n  const stem = basename(normalized, '.md');\n  const issueDraftsDir = dirname(normalized);\n  if (basename(issueDraftsDir) !== 'issues_drafts' || basename(dirname(issueDraftsDir)) !== 'docs') return null;\n  const workdir = dirname(dirname(issueDraftsDir));\n  return { workdir, stem, reviewDir: join(issueDraftsDir, '.review', stem) };\n}\n""",
    """interface WorkdirLayout {\n  workdir: string;\n  stem: string;\n  taskIdentity: string;\n  reviewDir: string;\n  canonicalIssueWorkdir: boolean;\n}\n\nfunction issueNumberFromStem(stem: string): string | null {\n  return stem.match(/^(\\d+)(?:-|$)/)?.[1] ?? null;\n}\n\nfunction canonicalIssueStateRoot(): string {\n  return resolve(process.env.HOME ?? homedir(), '.local', 'state', 'create-issue-draft');\n}\n\nfunction deriveWorkdir(draftPath: string): WorkdirLayout | null {\n  const normalized = resolve(draftPath);\n  const stem = basename(normalized, '.md');\n  const taskNumber = issueNumberFromStem(stem);\n  const issueDraftsDir = dirname(normalized);\n  if (!taskNumber || basename(issueDraftsDir) !== 'issues_drafts' || basename(dirname(issueDraftsDir)) !== 'docs') return null;\n  const workdir = dirname(dirname(issueDraftsDir));\n  const canonicalIssueWorkdir = dirname(workdir) === canonicalIssueStateRoot() && basename(workdir) === taskNumber;\n  const taskIdentity = canonicalIssueWorkdir ? taskNumber : stem;\n  return {\n    workdir,\n    stem,\n    taskIdentity,\n    reviewDir: canonicalIssueWorkdir\n      ? join(canonicalIssueStateRoot(), '.review', taskNumber)\n      : join(issueDraftsDir, '.review', taskIdentity),\n    canonicalIssueWorkdir,\n  };\n}\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """  const revisions: TierTransitionEvidence['revisions'] = [];\n  for (const revision of revisionDirs) {\n    const draftFile = join(layout.workdir, revision, `${layout.stem}.md`);\n    if (!existsSync(draftFile)) continue;\n    const text = readFileSync(draftFile, 'utf8');\n""",
    """  const revisions: TierTransitionEvidence['revisions'] = [];\n  for (const revision of revisionDirs) {\n    const revisionDir = join(layout.workdir, revision);\n    const candidates = readdirSync(revisionDir, { withFileTypes: true })\n      .filter((entry) => {\n        if (!entry.isFile() || !/\\.md$/i.test(entry.name)) return false;\n        const candidateStem = basename(entry.name, '.md');\n        return layout.canonicalIssueWorkdir\n          ? issueNumberFromStem(candidateStem) === layout.taskIdentity\n          : candidateStem === layout.stem;\n      })\n      .map((entry) => entry.name)\n      .sort();\n    if (candidates.length > 1) {\n      errors.push(`tier provenance: ambiguous immutable Issue revision files for ${revision}`);\n      continue;\n    }\n    const candidate = candidates[0];\n    if (!candidate) continue;\n    const draftFile = join(revisionDir, candidate);\n    const text = readFileSync(draftFile, 'utf8');\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """    evidence: { taskIdentity: layout.stem, currentRevision, intake, revisions, events, revalidations, captures },\n""",
    """    evidence: {\n      taskIdentity: layout.taskIdentity,\n      currentRevision,\n      intake,\n      revisions,\n      events,\n      revalidations,\n      captures,\n      canonicalIssueWorkdir: layout.canonicalIssueWorkdir,\n    },\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """  captures?: Array<{ captureName: string; captureText: string }>;\n}\n""",
    """  captures?: Array<{ captureName: string; captureText: string }>;\n  /** Filesystem-loaded evidence only: whether the path uses the Issue-number authority. */\n  canonicalIssueWorkdir?: boolean;\n}\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """function selectedCaptureKinds(tier: Tier): ReadonlySet<CanonicalCaptureKind> {\n  if (tier === 'T3') return new Set(['competitive', 'architectural-review', 'architectural-lens', 'architectural']);\n  return new Set(['architectural']);\n}\n""",
    """function selectedCaptureKinds(tier: Tier): ReadonlySet<CanonicalCaptureKind> {\n  const selected = new Set<CanonicalCaptureKind>();\n  for (const stage of selectAuthoringReviewStages({ tier, skipLine: false }).review) {\n    if (stage === 'competitive-adversarial') selected.add('competitive');\n    else if (stage === 'architect-lens') selected.add('architectural-lens');\n    else if (stage === 'final-architectural') selected.add('architectural');\n    else if (stage === 'architectural') selected.add(tier === 'T3' ? 'architectural-review' : 'architectural');\n  }\n  return selected;\n}\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """  let corrections = 0;\n  let sawUpstep = false;\n  for (let index = 1; index <= currentIndex; index += 1) {\n""",
    """  const hasCorrectionAttempt = evidence.revisions.slice(0, currentIndex + 1).some((revision, index, revisions) => {\n    if (revision.receipt?.correctedFrom || revision.receipt?.reason !== undefined) return true;\n    const previous = revisions[index - 1];\n    return Boolean(previous?.tier && revision.tier && tierRank(revision.tier) < tierRank(previous.tier));\n  });\n  if (hasCorrectionAttempt && evidence.canonicalIssueWorkdir === false) {\n    errors.push('tier correction: intake correction requires the canonical Issue-number workdir history');\n  }\n\n  let corrections = 0;\n  let sawUpstep = false;\n  for (let index = 1; index <= currentIndex; index += 1) {\n""",
)
replace_once(
    'scripts/lib/tier-gate-core.ts',
    """  const first = evidence.revisions[0];\n  if (first?.tier !== intake.priorTier) {\n""",
    """  const first = evidence.revisions[0];\n  if (first?.receipt?.correctedFrom || first?.receipt?.reason !== undefined) {\n    errors.push('tier correction: first authoritative receipt cannot contain correction fields');\n  }\n  if (first?.tier !== intake.priorTier) {\n""",
)

# 4. Fail closed on unreadable supplied calibration base refs.
replace_once(
    'scripts/tiering-calibration.ts',
    """function readBaseDocument(ref: string, path: string): string | undefined {\n  const result = runProcessSync({\n    command: 'git',\n    args: ['show', `${ref}:${path}`],\n    inheritParentEnv: true,\n  });\n  return result.ok ? result.stdout : undefined;\n}\n""",
    """function describeGitFailure(stderr: string, error?: string): string {\n  return stderr.trim() || error || 'unknown git failure';\n}\n\nfunction readBaseDocument(ref: string, path: string): string | undefined {\n  const verify = runProcessSync({\n    command: 'git',\n    args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],\n    inheritParentEnv: true,\n  });\n  if (!verify.ok) {\n    throw new Error(`unable to resolve supplied base ref ${ref}: ${describeGitFailure(verify.stderr, verify.error)}`);\n  }\n\n  const listing = runProcessSync({\n    command: 'git',\n    args: ['ls-tree', '--name-only', ref, '--', path],\n    inheritParentEnv: true,\n  });\n  if (!listing.ok) {\n    throw new Error(`unable to inspect ${path} at base ref ${ref}: ${describeGitFailure(listing.stderr, listing.error)}`);\n  }\n  if (listing.stdout.trim() === '') return undefined;\n\n  const content = runProcessSync({\n    command: 'git',\n    args: ['show', `${ref}:${path}`],\n    inheritParentEnv: true,\n  });\n  if (!content.ok) {\n    throw new Error(`unable to read ${path} at base ref ${ref}: ${describeGitFailure(content.stderr, content.error)}`);\n  }\n  return content.stdout;\n}\n""",
)
replace_once(
    'scripts/tiering-calibration.ts',
    """  const baseIndex = argv.indexOf('--base-ref');\n  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.PR_BASE_SHA;\n  const base = baseRef ? readBaseDocument(baseRef, 'docs/tiering-calibration.md') : undefined;\n  const errors = validateCalibration(candidate, base);\n""",
    """  const baseIndex = argv.indexOf('--base-ref');\n  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.PR_BASE_SHA;\n  let base: string | undefined;\n  try {\n    base = baseRef ? readBaseDocument(baseRef, 'docs/tiering-calibration.md') : undefined;\n  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    process.stderr.write(`tiering calibration: ${message}\\n`);\n    return 1;\n  }\n  const errors = validateCalibration(candidate, base);\n""",
)

# 5. Focused regressions for all findings.
replace_once(
    'scripts/tier-gate-guard.test.ts',
    "import { describe, expect, it } from 'vitest';\n",
    "import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { describe, expect, it, vi } from 'vitest';\n",
)
replace_once(
    'scripts/tier-gate-guard.test.ts',
    """} from './lib/tier-gate-core.ts';\n\nconst identity = '1142-fixture';\n""",
    """} from './lib/tier-gate-core.ts';\nimport { runCli } from './tier-gate-guard.ts';\n\nconst identity = '1142-fixture';\n""",
)
replace_once(
    'scripts/tier-gate-guard.test.ts',
    """  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {\n    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false }).review).toEqual(['architectural']);\n    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false }).review).toEqual(['architectural']);\n  });\n""",
    """  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {\n    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false }).review).toEqual(['architectural']);\n    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false }).review).toEqual(['architectural']);\n    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false, explicitAdversarialWrapper: true })).toMatchObject({\n      effectiveTier: 'T2',\n      review: ['architectural'],\n      wrapperFloorApplied: true,\n    });\n    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false, explicitAdversarialWrapper: true }).review).toEqual(['architectural']);\n  });\n""",
)
replace_once(
    'scripts/tier-gate-guard.test.ts',
    """  it('rejects correction after a selected canonical reviewer capture', () => {\n""",
    """  it('rejects correction fields on the first authoritative receipt', () => {\n    const current = draft('T2', 'T2');\n    const transitionEvidence = evidence([{\n      revision: 'r01',\n      text: current,\n      tier: 'T2',\n      receipt: receipt('r01', 'T2', { correctedFrom: 'T3', reason: 'false first-revision correction' }),\n    }], { priorTier: 'T2' });\n    expect(run(current, transitionEvidence).errors.join('\\n')).toContain('first authoritative receipt');\n  });\n\n  it('rejects correction after a selected canonical reviewer capture', () => {\n""",
)
replace_once(
    'scripts/tier-gate-guard.test.ts',
    """  it('rejects retired demotion fence fields for a fresh task', () => {\n""",
    """  it('fails closed when the same Issue is replayed through a second workdir', () => {\n    const tempHome = mkdtempSync(join(tmpdir(), 'tier-issue-history-'));\n    const previousHome = process.env.HOME;\n    const stateRoot = join(tempHome, '.local', 'state', 'create-issue-draft');\n    const firstWorkdir = join(stateRoot, '1142');\n    const replayWorkdir = join(stateRoot, '1142-replay');\n\n    const writeHistory = (workdir: string, stem: string, revisions: Array<{ revision: string; text: string; receipt: TierDecisionReceiptRecord }>, reviewIdentity: string): string => {\n      const issueDrafts = join(workdir, 'docs', 'issues_drafts');\n      const reviewDir = join(issueDrafts, '.review', reviewIdentity);\n      mkdirSync(reviewDir, { recursive: true });\n      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({\n        schema: 'tier-intake/v1',\n        producer: 'cursor-flow-manager',\n        taskIdentity: reviewIdentity,\n        kind: 'fresh',\n        priorTier: revisions[0]?.receipt.tier,\n        firstRevision: revisions[0]?.revision,\n      }));\n      for (const revision of revisions) {\n        const revisionDir = join(workdir, revision.revision);\n        mkdirSync(revisionDir, { recursive: true });\n        writeFileSync(join(revisionDir, `${stem}.md`), revision.text);\n        writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(revision.receipt));\n      }\n      const anchor = join(issueDrafts, `${stem}.md`);\n      mkdirSync(issueDrafts, { recursive: true });\n      writeFileSync(anchor, revisions.at(-1)?.text ?? '');\n      return anchor;\n    };\n\n    try {\n      process.env.HOME = tempHome;\n      const first = draft('T3', 'T3', { behavior: 'action-producing' });\n      writeHistory(firstWorkdir, '1142-original', [\n        { revision: 'r01', text: first, receipt: receipt('r01', 'T3') },\n      ], '1142');\n      const issueReviewDir = join(stateRoot, '.review', '1142');\n      mkdirSync(issueReviewDir, { recursive: true });\n      writeFileSync(join(issueReviewDir, 'tier-intake.json'), JSON.stringify({ schema: 'tier-intake/v1', producer: 'cursor-flow-manager', taskIdentity: '1142', kind: 'fresh', priorTier: 'T3', firstRevision: 'r01' }));\n      writeFileSync(join(issueReviewDir, 'pass-01-competitive.capture.txt'), 'issue_revision: r01\\nNO_FINDINGS');\n\n      const replayFirst = draft('T3', 'T3', { behavior: 'action-producing' });\n      const replayCurrent = draft('T2', 'T3', { behavior: 'action-producing' });\n      const replayAnchor = writeHistory(replayWorkdir, '1142-replay', [\n        { revision: 'r01', text: replayFirst, receipt: receipt('r01', 'T3') },\n        { revision: 'r02', text: replayCurrent, receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'replay attempt' }) },\n      ], '1142-replay');\n\n      const stderr: string[] = [];\n      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);\n      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);\n      try {\n        expect(runCli(['node', 'tier-gate-guard.ts', '--text-file', replayAnchor, '--draft-path', replayAnchor])).toBe(1);\n        expect(stderr.join('')).toContain('canonical Issue-number workdir history');\n      } finally {\n        stderrSpy.mockRestore();\n        stdoutSpy.mockRestore();\n      }\n    } finally {\n      if (previousHome === undefined) delete process.env.HOME;\n      else process.env.HOME = previousHome;\n      rmSync(tempHome, { recursive: true, force: true });\n    }\n  });\n\n  it('retains capture history when the anchor slug changes inside the canonical Issue workdir', () => {\n    const tempHome = mkdtempSync(join(tmpdir(), 'tier-slug-history-'));\n    const previousHome = process.env.HOME;\n    try {\n      process.env.HOME = tempHome;\n      const workdir = join(tempHome, '.local', 'state', 'create-issue-draft', '1142');\n      const issueDrafts = join(workdir, 'docs', 'issues_drafts');\n      const reviewDir = join(tempHome, '.local', 'state', 'create-issue-draft', '.review', '1142');\n      mkdirSync(reviewDir, { recursive: true });\n      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({ schema: 'tier-intake/v1', producer: 'cursor-flow-manager', taskIdentity: '1142', kind: 'fresh', priorTier: 'T3', firstRevision: 'r01' }));\n      writeFileSync(join(reviewDir, 'pass-01-competitive.capture.txt'), 'issue_revision: r01\\nNO_FINDINGS');\n\n      const first = draft('T3', 'T3', { behavior: 'action-producing' });\n      const current = draft('T2', 'T3', { behavior: 'action-producing' });\n      for (const [revision, stem, text, decision] of [\n        ['r01', '1142-old-slug', first, receipt('r01', 'T3')],\n        ['r02', '1142-new-slug', current, receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' })],\n      ] as const) {\n        const revisionDir = join(workdir, revision);\n        mkdirSync(revisionDir, { recursive: true });\n        writeFileSync(join(revisionDir, `${stem}.md`), text);\n        writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(decision));\n      }\n      const anchor = join(issueDrafts, '1142-new-slug.md');\n      mkdirSync(issueDrafts, { recursive: true });\n      writeFileSync(anchor, current);\n      const result = checkTierGateGuard(current, { repoRoot: process.cwd(), draftPath: anchor });\n      expect(result.errors.join('\\n')).toContain('already closed');\n    } finally {\n      if (previousHome === undefined) delete process.env.HOME;\n      else process.env.HOME = previousHome;\n      rmSync(tempHome, { recursive: true, force: true });\n    }\n  });\n\n  it('rejects retired demotion fence fields for a fresh task', () => {\n""",
)

replace_once(
    'scripts/tiering-calibration.test.ts',
    "import { readFileSync } from 'node:fs';\nimport { describe, expect, it } from 'vitest';\n",
    "import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { describe, expect, it, vi } from 'vitest';\n",
)
replace_once(
    'scripts/tiering-calibration.test.ts',
    """  serializeCalibrationRows,\n  validateCalibration,\n} from './tiering-calibration.ts';\n""",
    """  runCalibrationCli,\n  serializeCalibrationRows,\n  validateCalibration,\n} from './tiering-calibration.ts';\n""",
)
replace_once(
    'scripts/tiering-calibration.test.ts',
    """  it('requires the base row sequence as an exact prefix and permits append-only growth', () => {\n    const append = `${committed.trimEnd()}\\n| 1200 | T2 | T2 | T2 | T2 |\\n`;\n    expect(validateCalibration(append, committed)).toEqual([]);\n    const editedBase = mutateRow(append, '1030', '| 1030 | T3 | T3 | T3 | T3 |');\n    expect(validateCalibration(editedBase, committed).join('\\n')).toContain('exact prefix');\n  });\n""",
    """  it('requires the base row sequence as an exact prefix and permits append-only growth', () => {\n    const append = `${committed.trimEnd()}\\n| 1200 | T2 | T2 | T2 | T2 |\\n`;\n    expect(validateCalibration(append, committed)).toEqual([]);\n    const editedBase = mutateRow(append, '1030', '| 1030 | T3 | T3 | T3 | T3 |');\n    expect(validateCalibration(editedBase, committed).join('\\n')).toContain('exact prefix');\n  });\n\n  it('fails closed when a supplied base ref cannot be resolved', () => {\n    const temp = mkdtempSync(join(tmpdir(), 'tiering-calibration-'));\n    const candidate = join(temp, 'tiering-calibration.md');\n    writeFileSync(candidate, committed);\n    const stderr: string[] = [];\n    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);\n    try {\n      expect(runCalibrationCli(['--file', candidate, '--base-ref', 'refs/heads/definitely-missing-tiering-base'])).toBe(1);\n      expect(stderr.join('')).toContain('unable to resolve supplied base ref');\n    } finally {\n      spy.mockRestore();\n      rmSync(temp, { recursive: true, force: true });\n    }\n  });\n""",
)
