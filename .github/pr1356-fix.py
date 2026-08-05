from pathlib import Path
import subprocess


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    file.write_text(text.replace(old, new, count))


def run(*args: str) -> None:
    subprocess.run(args, check=True)


artifacts = "scripts/lib/create-issue-stage-record-artifacts.ts"
replace(
    artifacts,
    "  operatorAdjudication?: OperatorAcceptanceAdjudication;\n  operatorReferenceTransport?: GhTransport;\n",
    "  operatorAdjudication?: OperatorAcceptanceAdjudication;\n  operatorReferenceTransport?: GhTransport;\n  repositoryFullName?: string;\n",
)

terminal_parser = r'''
function parseCanonicalTerminalVerdict(
  text: string,
): { issueNumber: number; sourceRevision: string; findingCount: number } | null {
  const revision = parseCanonicalCaptureRevision(text);
  if (!revision) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const exactCount = (token: string): number => lines.filter((line) => line === token).length;
  const verdicts = lines.flatMap((line) => {
    const match = /^VERDICT: (CLEAN|FINDINGS)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  const declaredFindingCounts = lines.flatMap((line) => {
    const match = /^FINDING_COUNT: ([0-9]+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const invocationIds = lines.filter((line) => /^INVOCATION_ID: \S+$/.test(line));
  if (
    exactCount('review-economics-contract: v1') !== 1
    || exactCount('SIMPLIFICATION_CLEAN') !== 1
    || verdicts.length !== 1
    || declaredFindingCounts.length !== 1
    || declaredFindingCounts[0] !== revision.findingCount
    || invocationIds.length !== 1
  ) return null;
  if (revision.findingCount === 0) {
    if (verdicts[0] !== 'CLEAN' || exactCount('NO_FINDINGS') !== 1) return null;
  } else if (verdicts[0] !== 'FINDINGS' || exactCount('NO_FINDINGS') !== 0) {
    return null;
  }
  return revision;
}
'''
replace(
    artifacts,
    "\nfunction normalizeOperatorAcceptanceAdjudication(\n",
    terminal_parser + "\nfunction normalizeOperatorAcceptanceAdjudication(\n",
)
replace(
    artifacts,
    """function normalizeOperatorAcceptanceAdjudication(
  value: OperatorAcceptanceAdjudication | undefined,
  phase: ProduceAcceptanceArtifactsOptions['phase'],
  transport: GhTransport | undefined,
  errors: string[],
): NormalizedOperatorAcceptanceAdjudication | null {
""",
    """function normalizeOperatorAcceptanceAdjudication(
  value: OperatorAcceptanceAdjudication | undefined,
  phase: ProduceAcceptanceArtifactsOptions['phase'],
  transport: GhTransport | undefined,
  authoritativeRepositoryFullName: string,
  authoritativeIssueNumber: number,
  authoritativeSourceRevision: string,
  errors: string[],
): NormalizedOperatorAcceptanceAdjudication | null {
""",
)
replace(
    artifacts,
    """  const verdictFindingCount = Number(value.verdictFindingCount);
  const reason = String(value.reason ?? '').trim();
  if (!Number.isInteger(issueNumber) || issueNumber < 1) errors.push('operator adjudication issueNumber must be positive');
""",
    """  const verdictFindingCount = Number(value.verdictFindingCount);
  const reason = String(value.reason ?? '').trim();
  const canonicalRepository = authoritativeRepositoryFullName.trim();
  if (!/^[^/\\s]+\\/[^/\\s]+$/.test(canonicalRepository)) {
    errors.push('operator adjudication authoritative repository must be owner/name');
  }
  if (!Number.isInteger(issueNumber) || issueNumber < 1) errors.push('operator adjudication issueNumber must be positive');
  if (issueNumber !== authoritativeIssueNumber) {
    errors.push('operator adjudication Issue does not match authoritative tier-intake Issue');
  }
  if (sourceRevision !== authoritativeSourceRevision) {
    errors.push('operator adjudication revision does not match authoritative review episode');
  }
""",
)
replace(
    artifacts,
    """  if (!match) errors.push('operator adjudication verdictUrl must be a canonical published Issue comment URL');
  else if (Number(match[2]) !== issueNumber) errors.push('operator adjudication verdictUrl Issue does not match issueNumber');
""",
    """  if (!match) {
    errors.push('operator adjudication verdictUrl must be a canonical published Issue comment URL');
  } else {
    if (match[1]!.toLowerCase() !== canonicalRepository.toLowerCase()) {
      errors.push('operator adjudication verdictUrl repository does not match authoritative repository');
    }
    if (Number(match[2]) !== issueNumber) {
      errors.push('operator adjudication verdictUrl Issue does not match issueNumber');
    }
  }
""",
)
replace(artifacts, "  const repositoryFullName = match[1]!;\n", "  const repositoryFullName = canonicalRepository;\n")
replace(
    artifacts,
    """  const parsed = parseCanonicalCaptureRevision(authoritativeBody);
  if (!parsed) {
    errors.push('operator adjudication published verdict has no unique canonical revision declaration');
""",
    """  const parsed = parseCanonicalTerminalVerdict(authoritativeBody);
  if (!parsed) {
    errors.push('operator adjudication published verdict is not a canonical terminal verdict');
""",
)
replace(
    artifacts,
    """  if (!context || !capture || captureText === null) return null;
  const adjudication = context.adjudication;
""",
    """  if (!context || !capture || captureText === null) return null;
  const errorCountBefore = errors.length;
  const adjudication = context.adjudication;
""",
)
replace(
    artifacts,
    """  const parsed = parseCanonicalCaptureRevision(captureText);
  if (!parsed) {
    errors.push('operator adjudication governed capture has no unique canonical revision declaration');
""",
    """  const parsed = parseCanonicalTerminalVerdict(captureText);
  if (!parsed) {
    errors.push('operator adjudication governed capture is not a canonical terminal verdict');
""",
)
replace(artifacts, "  if (errors.length > 0) return null;\n", "  if (errors.length !== errorCountBefore) return null;\n")

old_non_ok = """  const identity = turnResultIdentity(basename(resolved), sha256(text));
  if (stateValid && value.state !== 'ok' && terminalFieldsValid && invocationMatches) {
    const adjudicated = applyOperatorAcceptanceAdjudication(
      operatorContext,
      invocation,
      capture,
      captureText,
      {
        state: String(value.state),
        scope: String(value.scope),
        cause: String(value.cause),
        terminalClassification: String(invocation.terminalClassification ?? ''),
        turnResultPath: resolved,
        ...(Number.isInteger(value.send_count) ? { sendCount: Number(value.send_count) } : {}),
        terminalResultIdentity: identity,
      },
      errors,
    );
    if (adjudicated) {
      if (invocation.terminalResultIdentity !== identity) {
        errors.push(`stage evidence ${label}.terminalResultIdentity is not derived from the referenced turn-result: ${resolved}`);
      }
      return identity;
    }
    errors.push(`turn-result/v1 artifact for ${label} is not a successful terminal result: ${resolved}`);
  }
"""
new_non_ok = """  const identity = turnResultIdentity(basename(resolved), sha256(text));
  if (stateValid && value.state !== 'ok' && terminalFieldsValid && invocationMatches) {
    const invocationSendCount = Number(invocation.sendCount);
    let originalSendCount = invocationSendCount;
    let sendCountMatches = true;
    if (value.send_count !== undefined) {
      if (value.send_count !== 0 && value.send_count !== 1) {
        errors.push(`turn-result/v1 artifact for ${label}.send_count must be 0 or 1: ${resolved}`);
        sendCountMatches = false;
      } else if (Number(value.send_count) !== invocationSendCount) {
        errors.push(`turn-result/v1 artifact for ${label}.send_count does not match stage evidence: ${resolved}`);
        sendCountMatches = false;
      } else {
        originalSendCount = Number(value.send_count);
      }
    }
    const adjudicated = sendCountMatches
      ? applyOperatorAcceptanceAdjudication(
          operatorContext,
          invocation,
          capture,
          captureText,
          {
            state: String(value.state),
            scope: String(value.scope),
            cause: String(value.cause),
            terminalClassification: String(invocation.terminalClassification ?? ''),
            turnResultPath: resolved,
            sendCount: originalSendCount,
            terminalResultIdentity: identity,
          },
          errors,
        )
      : null;
    if (adjudicated) {
      if (invocation.terminalResultIdentity !== identity) {
        errors.push(`stage evidence ${label}.terminalResultIdentity is not derived from the referenced turn-result: ${resolved}`);
      }
    } else {
      errors.push(`turn-result/v1 artifact for ${label} is not a successful terminal result: ${resolved}`);
    }
  }
"""
replace(artifacts, old_non_ok, new_non_ok)

old_produce = """  const outputDir = options.outputDir ?? options.reviewDir;
  invalidateOutputArtifacts(outputDir);
  const errors: string[] = [];
  const operatorAdjudication = normalizeOperatorAcceptanceAdjudication(
    options.operatorAdjudication,
    options.phase,
    options.operatorAdjudication ? options.operatorReferenceTransport ?? defaultGhTransport() : undefined,
    errors,
  );
  const operatorContext = operatorAdjudication
    ? { adjudication: operatorAdjudication, applications: [] } satisfies OperatorAdjudicationContext
    : undefined;
  const intake = loadTierIntake(options.tierIntakePath, errors);
  const taskIdentity = intake && requiredString(intake.taskIdentity, 'tier-intake.taskIdentity', errors);
  const episodeFirstRevision = intake && requiredString(intake.firstRevision, 'tier-intake.firstRevision', errors);
  if (!intake || !taskIdentity || !episodeFirstRevision) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
  }
"""
new_produce = """  const outputDir = options.outputDir ?? options.reviewDir;
  if (!options.operatorAdjudication) invalidateOutputArtifacts(outputDir);
  const errors: string[] = [];
  const intake = loadTierIntake(options.tierIntakePath, errors);
  const taskIdentity = intake && requiredString(intake.taskIdentity, 'tier-intake.taskIdentity', errors);
  const episodeFirstRevision = intake && requiredString(intake.firstRevision, 'tier-intake.firstRevision', errors);
  if (!intake || !taskIdentity || !episodeFirstRevision) {
    return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
  }
  let operatorAdjudication: NormalizedOperatorAcceptanceAdjudication | null = null;
  if (options.operatorAdjudication) {
    const taskIssueMatch = /^issue:([1-9][0-9]*)$/.exec(taskIdentity);
    if (!taskIssueMatch) {
      errors.push('operator adjudication requires an authoritative tier-intake Issue identity');
    } else {
      operatorAdjudication = normalizeOperatorAcceptanceAdjudication(
        options.operatorAdjudication,
        options.phase,
        options.operatorReferenceTransport ?? defaultGhTransport(),
        options.repositoryFullName ?? 'chetwerikoff/orchestrator-pack',
        Number(taskIssueMatch[1]),
        episodeFirstRevision,
        errors,
      );
    }
    if (!operatorAdjudication) {
      return { ok: false, outputDir, files: [], missing: [], errors: [...new Set(errors)] };
    }
    invalidateOutputArtifacts(outputDir);
  }
  const operatorContext = operatorAdjudication
    ? { adjudication: operatorAdjudication, applications: [] } satisfies OperatorAdjudicationContext
    : undefined;
"""
replace(artifacts, old_produce, new_produce)

old_inspect = """  const present: string[] = [];
  const missing: AcceptanceArtifactMissingInput[] = [];
  const operatorErrors: string[] = [];
  const operatorAdjudication = normalizeOperatorAcceptanceAdjudication(
    options.operatorAdjudication,
    options.phase,
    options.operatorAdjudication ? options.operatorReferenceTransport ?? defaultGhTransport() : undefined,
    operatorErrors,
  );
  for (const error of operatorErrors) missing.push({ artifact: 'operator adjudication', reason: error });
  const operatorContext = operatorAdjudication
    ? { adjudication: operatorAdjudication, applications: [] } satisfies OperatorAdjudicationContext
    : undefined;
  const outputDir = options.outputDir ?? options.reviewDir;
"""
replace(
    artifacts,
    old_inspect,
    """  const present: string[] = [];
  const missing: AcceptanceArtifactMissingInput[] = [];
  let operatorContext: OperatorAdjudicationContext | undefined;
  const outputDir = options.outputDir ?? options.reviewDir;
""",
)
old_intake = """  const intake = readArtifactJson(options.tierIntakePath, 'tier-intake/v1', 'tier intake evidence is missing');
  if (!isRecord(intake) || intake.schema !== 'tier-intake/v1') {
    addInvalid('tier-intake/v1', options.tierIntakePath, 'tier intake evidence is malformed');
  }
"""
new_intake = """  const intake = readArtifactJson(options.tierIntakePath, 'tier-intake/v1', 'tier intake evidence is missing');
  if (!isRecord(intake) || intake.schema !== 'tier-intake/v1') {
    addInvalid('tier-intake/v1', options.tierIntakePath, 'tier intake evidence is malformed');
  } else if (options.operatorAdjudication) {
    const taskIdentity = typeof intake.taskIdentity === 'string' ? intake.taskIdentity.trim() : '';
    const firstRevision = typeof intake.firstRevision === 'string' ? intake.firstRevision.trim() : '';
    const taskIssueMatch = /^issue:([1-9][0-9]*)$/.exec(taskIdentity);
    const operatorErrors: string[] = [];
    if (!taskIssueMatch || !firstRevision) {
      operatorErrors.push('operator adjudication requires an authoritative tier-intake Issue identity');
    } else {
      const operatorAdjudication = normalizeOperatorAcceptanceAdjudication(
        options.operatorAdjudication,
        options.phase,
        options.operatorReferenceTransport ?? defaultGhTransport(),
        options.repositoryFullName ?? 'chetwerikoff/orchestrator-pack',
        Number(taskIssueMatch[1]),
        firstRevision,
        operatorErrors,
      );
      if (operatorAdjudication) {
        operatorContext = { adjudication: operatorAdjudication, applications: [] };
      }
    }
    for (const error of operatorErrors) missing.push({ artifact: 'operator adjudication', reason: error });
  }
"""
replace(artifacts, old_intake, new_intake)

cli = "scripts/lib/create-issue-stage-record-cli.ts"
replace(cli, "  operatorIssueNumber?: number;\n", "  operatorIssueNumber?: string;\n")
replace(cli, "  operatorVerdictByteLength?: number;\n", "  operatorVerdictByteLength?: string;\n")
replace(cli, "  operatorFindingCount?: number;\n", "  operatorFindingCount?: string;\n")
replace(cli, "        opts.operatorIssueNumber = Number(argv[++i]);\n", "        opts.operatorIssueNumber = String(argv[++i] ?? '');\n")
replace(cli, "        opts.operatorVerdictByteLength = Number(argv[++i]);\n", "        opts.operatorVerdictByteLength = String(argv[++i] ?? '');\n")
replace(cli, "        opts.operatorFindingCount = Number(argv[++i]);\n", "        opts.operatorFindingCount = String(argv[++i] ?? '');\n")
replace(
    cli,
    """        phase: opts.phase,
        operatorAdjudication: operatorAcceptanceAdjudication(opts),
      };
""",
    """        phase: opts.phase,
        operatorAdjudication: operatorAcceptanceAdjudication(opts),
        repositoryFullName: opts.repo,
      };
""",
)

runner = "scripts/pack-review-runner.ts"
replace(
    runner,
    """  if (unresolvedIdentity) {
    return {
      ok: false,
      created: false,
      reused: false,
      reason: unresolvedIdentity.reason,
      runId: unresolvedIdentity.runId,
      prNumber: target.prNumber,
      headSha: target.headSha,
      httpStatus: 409,
    };
  }

  const reviewer = resolvePackReviewerFromEnv(process.env, {
""",
    """  if (unresolvedIdentity) {
    return {
      ok: false,
      created: false,
      reused: false,
      reason: unresolvedIdentity.reason,
      runId: unresolvedIdentity.runId,
      prNumber: target.prNumber,
      headSha: target.headSha,
      httpStatus: 409,
    };
  }
  if (target.operatorStart) {
    const existingSameHead = listPackReviewRunRecordsRaw({ projectId, storeRoot }).find((record) => (
      record.prNumber === target.prNumber
      && record.headSha.toLowerCase() === target.headSha.toLowerCase()
    ));
    if (existingSameHead) {
      throw new Error(`operator pack-review start cannot reuse or resume existing same-head run ${existingSameHead.id}`);
    }
  }

  const reviewer = resolvePackReviewerFromEnv(process.env, {
""",
)

run("git", "diff", "--check")
run("git", "config", "user.name", "github-actions[bot]")
run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
run("git", "add", artifacts, cli, runner)
run("git", "commit", "-m", "fix: harden operator review gates")

# Tests.
artifact_test = "scripts/lib/create-issue-stage-record-artifacts.test.ts"
replace(
    artifact_test,
    """      'review-economics-contract: v1',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      '',
""",
    """      'review-economics-contract: v1',
      'VERDICT: CLEAN',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      'FINDING_COUNT: 0',
      'INVOCATION_ID: fixture-terminal-1192',
      '',
""",
)
replace(
    artifact_test,
    """invocation_id: 'invocation-001',
send_count: 1,
configured_profile_key: 'fixture-profile',
        };
""",
    """invocation_id: 'invocation-001',
configured_profile_key: 'fixture-profile',
output: {
  byte_length: Buffer.byteLength(capture),
  sha256: createHash('sha256').update(capture).digest('hex'),
},
        };
""",
)
replace(
    artifact_test,
    """state: transportState,
terminalClassification: 'complete',
        },
""",
    """state: transportState,
terminalClassification: 'complete',
sendCount: 1,
        },
""",
)

artifact_cases = r'''

  it.each([
    {
      name: 'tier-intake Issue mismatch',
      prepare: (input: ReturnType<typeof fixture>, capture: string) => {
        writeFileSync(input.intakePath, JSON.stringify({
          schema: 'tier-intake/v1', producer: 'flow-manager', taskIdentity: 'issue:1193',
          kind: 'fresh', priorTier: 'T2', firstRevision: 'r01',
        }));
        return { adjudication: adjudication(capture), repositoryFullName: 'chetwerikoff/orchestrator-pack' };
      },
      expected: 'operator adjudication Issue does not match authoritative tier-intake Issue',
    },
    {
      name: 'review-episode revision mismatch',
      prepare: (_input: ReturnType<typeof fixture>, capture: string) => ({
        adjudication: { ...adjudication(capture), sourceRevision: 'r02' },
        repositoryFullName: 'chetwerikoff/orchestrator-pack',
      }),
      expected: 'operator adjudication revision does not match authoritative review episode',
    },
    {
      name: 'cross-repository same-number comment',
      prepare: (_input: ReturnType<typeof fixture>, capture: string) => ({
        adjudication: {
          ...adjudication(capture),
          verdictUrl: 'https://github.com/other/repository/issues/1192#issuecomment-5194504082',
        },
        repositoryFullName: 'chetwerikoff/orchestrator-pack',
      }),
      expected: 'operator adjudication verdictUrl repository does not match authoritative repository',
    },
  ])('rejects $name before transport or artifact mutation', ({ prepare, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'pre-side-effect-rejection');
    mkdirSync(outputDir, { recursive: true });
    const sentinel = join(outputDir, 'acceptance-artifacts.json');
    writeFileSync(sentinel, 'sentinel');
    const runGh = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const prepared = prepare(input, capture);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: prepared.adjudication,
      repositoryFullName: prepared.repositoryFullName,
      operatorReferenceTransport: { runGh },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(expected);
    expect(runGh).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects a matching non-terminal progress comment', () => {
    const input = fixture();
    const capture = [
      'Read revision: #1192 r01',
      'review-economics-contract: v1',
      'progress: still reviewing',
      'SIMPLIFICATION_CLEAN',
      '',
    ].join('\n');
    writeFileSync(input.capturePath, capture);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    delete evidence.invocations[0].turnResultPath;
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, 'operator-non-terminal');
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operator adjudication published verdict is not a canonical terminal verdict');
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    {
      name: 'output metadata mismatch',
      mutateResult: (failed: Record<string, unknown>) => {
        failed.output = { byte_length: 1, sha256: '0'.repeat(64) };
      },
      mutateEvidence: (_evidence: Record<string, any>) => {},
      expected: 'output does not match capture bytes',
    },
    {
      name: 'terminal-result identity mismatch',
      mutateResult: (_failed: Record<string, unknown>) => {},
      mutateEvidence: (evidence: Record<string, any>) => {
        evidence.invocations[0].terminalResultIdentity = 'sha256:' + '0'.repeat(64) + ':turn-result.json';
      },
      expected: 'terminalResultIdentity is not derived from the referenced turn-result',
    },
  ])('continues through the existing $name guard after suppressing only non-ok state', ({ mutateResult, mutateEvidence, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const failed: Record<string, unknown> = {
      schema: 'turn-result/v1',
      state: 'driver_error',
      scope: 'invocation',
      cause: 'browser_lost',
      invocation_id: 'invocation-001',
      configured_profile_key: 'fixture-profile',
      output: {
        byte_length: Buffer.byteLength(capture),
        sha256: createHash('sha256').update(capture).digest('hex'),
      },
    };
    mutateResult(failed);
    const failedText = JSON.stringify(failed);
    writeFileSync(input.turnResultPath, failedText);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    evidence.invocations[0].terminalResultIdentity = 'sha256:'
      + createHash('sha256').update(failedText).digest('hex') + ':' + basename(input.turnResultPath);
    mutateEvidence(evidence);
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, `operator-downstream-${expected.replaceAll(' ', '-')}`);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(expected);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    { sendCount: 0, expected: 'send_count does not match stage evidence' },
    { sendCount: 2, expected: 'send_count must be 0 or 1' },
  ])('rejects adjudicated turn-result send_count $sendCount consistently', ({ sendCount, expected }) => {
    const input = fixture();
    const capture = governedCapture();
    writeFileSync(input.capturePath, capture);
    const failed = {
      schema: 'turn-result/v1',
      state: 'driver_error',
      scope: 'invocation',
      cause: 'browser_lost',
      invocation_id: 'invocation-001',
      configured_profile_key: 'fixture-profile',
      send_count: sendCount,
      output: {
        byte_length: Buffer.byteLength(capture),
        sha256: createHash('sha256').update(capture).digest('hex'),
      },
    };
    const failedText = JSON.stringify(failed);
    writeFileSync(input.turnResultPath, failedText);
    const evidence = JSON.parse(readFileSync(input.stageEvidencePath, 'utf8'));
    evidence.invocations[0].terminalResultIdentity = 'sha256:'
      + createHash('sha256').update(failedText).digest('hex') + ':' + basename(input.turnResultPath);
    writeFileSync(input.stageEvidencePath, JSON.stringify(evidence));
    const outputDir = join(input.dir, `operator-send-count-${sendCount}`);
    const result = produceAcceptanceArtifacts({
      reviewDir: input.dir,
      outputDir,
      tierIntakePath: input.intakePath,
      stageEvidencePaths: [input.stageEvidencePath],
      authorDispositionsPath: input.authorPath,
      phase: 'final-acceptance',
      operatorAdjudication: adjudication(capture),
      operatorReferenceTransport: referenceTransport(capture),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(expected);
    expect(existsSync(join(outputDir, 'acceptance-artifacts.json'))).toBe(false);
  });

  it.each([
    ['operator Issue', '--operator-issue-number'],
    ['verdict byte length', '--operator-verdict-byte-length'],
    ['finding count', '--operator-finding-count'],
  ])('rejects a blank numeric CLI value for %s before artifact production', (_name, blankFlag) => {
    const input = fixture();
    const capture = governedCapture();
    const args = [
      'node', 'create-issue-stage-finalize.ts', 'produce-artifacts',
      '--review-dir', input.dir,
      '--tier-intake', input.intakePath,
      '--stage-evidence', input.stageEvidencePath,
      '--author-dispositions', input.authorPath,
      '--phase', 'final-acceptance',
      '--operator-issue-number', '1192',
      '--operator-source-revision', 'r01',
      '--operator-verdict-url', adjudication(capture).verdictUrl,
      '--operator-verdict-sha256', adjudication(capture).verdictSha256,
      '--operator-verdict-byte-length', String(Buffer.byteLength(capture)),
      '--operator-finding-count', '0',
      '--operator-reason', 'direct operator reason',
    ];
    const index = args.indexOf(blankFlag);
    args[index + 1] = '';
    expect(() => runStageFinalizeCli(args)).toThrow(
      /operator adjudication requires Issue, revision, verdict URL\/hash\/bytes\/findings, and reason/,
    );
  });
'''
file = Path(artifact_test)
text = file.read_text()
marker = "\n});\n"
pos = text.rfind(marker)
if pos < 0:
    raise SystemExit("operator artifact describe terminator not found")
file.write_text(text[:pos] + artifact_cases + text[pos:])

runner_test = "scripts/pack-review-runner-gpt.test.ts"
old_matrix = """  it('rejects incomplete or mismatched operator identity before run creation', async () => {
    const storeRoot = tempRoot('opk-1341-operator-reject-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    let started = false;

    await expect(startPackReview(operatorInput(storeRoot, {
      operatorReason: '',
      onRunStarted: () => { started = true; },
    }))).rejects.toThrow(/requires repository, Issue number, bound snapshot, and reason/);
    await expect(startPackReview(operatorInput(storeRoot, {
      operatorBoundSnapshot: `sha256:${'f'.repeat(64)}`,
      onRunStarted: () => { started = true; },
    }))).rejects.toThrow(/does not match authoritative review context/);
    await expect(startPackReview(operatorInput(storeRoot, {
      operatorRepository: 'other/repository',
      onRunStarted: () => { started = true; },
    }))).rejects.toThrow(/does not match operator target/);
    expect(started).toBe(false);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
  });
"""
new_matrix = """  it.each([
    ['missing repository', { operatorRepository: undefined }, /requires repository, Issue number, bound snapshot, and reason/],
    ['missing Issue', { operatorIssueNumber: undefined }, /requires repository, Issue number, bound snapshot, and reason/],
    ['missing snapshot', { operatorBoundSnapshot: undefined }, /requires repository, Issue number, bound snapshot, and reason/],
    ['missing reason', { operatorReason: '' }, /requires repository, Issue number, bound snapshot, and reason/],
    ['wrong repository', { operatorRepository: 'other/repository' }, /does not match operator target/],
    ['wrong snapshot', { operatorBoundSnapshot: `sha256:${'f'.repeat(64)}` }, /does not match authoritative review context/],
    ['short head', { headSha: 'a'.repeat(39) }, /full 40-hex head SHA/],
    ['stale head', { headSha: HEAD_B }, /review target head changed/],
    ['closed PR', { fixturePrState: 'CLOSED' }, /is not open/],
    ['missing authoritative snapshot', { fixtureIssueBody: undefined }, /bound snapshot does not match authoritative review context/],
    ['autonomous bound session', { sessionId: 'worker-session' }, /valid only when the session binding is absent/],
  ])('rejects %s before run creation or reviewer start', async (_name, overrides, error) => {
    const storeRoot = tempRoot('opk-1341-operator-matrix-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    let started = false;
    await expect(startPackReview(operatorInput(storeRoot, {
      ...overrides,
      onRunStarted: () => { started = true; },
    }))).rejects.toThrow(error);
    expect(started).toBe(false);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
  });
"""
replace(runner_test, old_matrix, new_matrix)

reuse_cases = r'''

  it.each(['active', 'journaled-terminal'])('rejects operator invocation on %s same-head run without mutating provenance', async (kind) => {
    const storeRoot = tempRoot('opk-1341-operator-existing-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1341,
      headSha: HEAD_A,
      linkedSessionId: 'original-session',
      startReason: 'original reason',
      surface: 'original surface',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    });
    if (kind === 'journaled-terminal') {
      setPackReviewRunTerminal(created.run.id, 'commented', {
        reviewVerdict: 'clean',
        findingCount: 0,
        findings: [],
      }, { projectId: 'orchestrator-pack', storeRoot });
      updatePackReviewRun(created.run.id, {
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: new Date().toISOString(),
          reason: 'fixture persisted verdict',
          idempotencyKey: `verdict:${created.run.id}:${HEAD_A}`,
          attempts: 1,
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
    }
    await expect(startPackReview(operatorInput(storeRoot))).rejects.toThrow(
      /cannot reuse or resume existing same-head run/,
    );
    const stored = getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(stored?.startReason).toBe('original reason');
    expect(stored?.surface).toBe('original surface');
    expect(stored?.linkedSessionId).toBe('original-session');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
  });
'''
file = Path(runner_test)
text = file.read_text()
anchor = "\n  it('preserves the exact legacy missing-binding failure without operator input', async () => {"
if anchor not in text:
    raise SystemExit("runner no-input parity anchor not found")
file.write_text(text.replace(anchor, reuse_cases + anchor, 1))

run("git", "diff", "--check")
run("git", "add", artifact_test, runner_test)
run("git", "commit", "-m", "test: cover operator gate rejection matrices")

run("npm", "run", "check:node-major", "--silent")
run(
    "node",
    "scripts/run-vitest-with-harness.mjs",
    "run",
    "--maxWorkers=1",
    "scripts/pack-review-runner-gpt.test.ts",
    "scripts/lib/create-issue-stage-record-artifacts.test.ts",
    "scripts/lib/create-issue-stage-record.test.ts",
)
run("npm", "run", "typecheck:foundation")
run("npm", "run", "lint:foundation")
run("git", "push", "origin", "HEAD:agent/issue-1341-operator-inputs")
