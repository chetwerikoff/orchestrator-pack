replace_once(state, "    return url.includes('/c/') ? url : undefined;", "    return isSupportedChatGptConversationUrl(url) ? url : undefined;")
# Replace entire finalizer.
regex_once(
    state,
    r"async function finalizeTurn\(outcome: TurnRunOutcome\): Promise<CompactTurnResult> \{(?:.|\n)*?\n}\n\nexport const __testFinalizeTurn",
    """async function finalizeTurn(outcome: TurnRunOutcome): Promise<CompactTurnResult> {
  let cleanup: ResourceCleanupOutcome = 'skipped';
  let journalWriteFailed = outcome.result.journal_write_failed === true;
  const incidents = [...outcome.result.incidents];
  const pageLost = browserOrPageDefinitelyLost(outcome.page, outcome.browser);
  const implicitStopAuthority = Boolean(
    outcome.page
    && typeof outcome.page === 'object'
    && stopAuthorityPages.has(outcome.page),
  ) ? outcome.page : undefined;
  const stopAuthorityPage = !outcome.ownershipForfeited
    ? outcome.stopAuthorityPage ?? implicitStopAuthority
    : undefined;

  if (outcome.result.send_count >= 1 && outcome.result.state !== 'ok') {
    const stopOutcome: StopOwnedGenerationOutcome = stopAuthorityPage
      && !browserOrPageDefinitelyLost(stopAuthorityPage, outcome.browser)
      ? await stopOwnedGeneration(stopAuthorityPage)
      : 'unavailable';
    const stopIncident: BrowserIncident = {
      eventClass: `owned_generation_stop_${stopOutcome}`,
      symptom: `${outcome.result.state}:${outcome.result.cause}`,
      action: 'defer_exact_target_close_to_issue_1266',
    };
    incidents.push(stopIncident.eventClass);
    if (!appendIncident(stopIncident, outcome.result.invocation_id)) journalWriteFailed = true;
  }

  const cleanupAuthorityProven = Boolean(
    outcome.page
    && typeof outcome.page === 'object'
    && !cleanupAuthorityUnprovenPages.has(outcome.page),
  );
  const requestedPageAction = outcome.cleanupAction ?? decidePageCleanupAction({
    sendCount: outcome.result.send_count,
    publicationState: outcome.publicationState,
    pagePresent: cleanupAuthorityProven,
    pageLost,
  });
  // Issue #1266 owns abandonment close. This change may Stop only the exact
  // proven target and must preserve every post-send non-ok tab.
  const pageAction = outcome.result.send_count >= 1 && outcome.result.state !== 'ok'
    ? 'preserve'
    : requestedPageAction;
  if (pageAction === 'close') {
    cleanup = await boundedResourceCleanup(
      () => outcome.page.close(),
      RESOURCE_CLEANUP_BOUND_MS,
    );
    if (cleanup !== 'confirmed') {
      incidents.push('owned_tab_cleanup_failed');
      const cleanupIncident: BrowserIncident = {
        eventClass: 'owned_tab_cleanup_failed',
        symptom: 'owned_tab_close_unconfirmed',
        action: 'leave_sibling_tabs_untouched',
      };
      if (!appendIncident(cleanupIncident, outcome.result.invocation_id)) journalWriteFailed = true;
    }
  }

  if (outcome.profileKey && outcome.ownedConversationUrl && !outcome.ownershipForfeited) {
    releaseStateLightFreshConversationClaim(
      outcome.profileKey,
      outcome.ownedConversationUrl,
      outcome.result.invocation_id,
    );
  }
  await releaseCdpBrowser(outcome.browser);
  return {
    ...outcome.result,
    cleanup,
    incidents,
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
  };
}

export const __testFinalizeTurn""",
)

flow = 'scripts/flow-manager-long-running-child.ts'
replace_once(flow, "import { runProcess, type ProcessResult } from './kernel/subprocess.ts';", "import { runProcess, type ProcessResult } from './kernel/subprocess.ts';\nimport { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';\nimport {\n  cancelOwnedGenerationFromReceipt,\n  parseBrowserTurnCancellationReceipt,\n  type BrowserTurnCancellationAttempt,\n  type BrowserTurnCancellationDependencies,\n  type BrowserTurnCancellationReceipt,\n} from './chatgpt-browser-turn/state-light-cancellation.ts';")
replace_once(flow, "interface CandidateCapture {\n  firstCandidate: ParsedTurnResult | null;\n  duplicateCandidate: boolean;", "interface CandidateCapture {\n  firstCandidate: ParsedTurnResult | null;\n  duplicateCandidate: boolean;\n  cancellationReceipt: BrowserTurnCancellationReceipt | null;\n  duplicateCancellationReceipt: boolean;")
replace_once(flow, "  readonly secretCanaries?: readonly string[];\n}", "  readonly secretCanaries?: readonly string[];\n  readonly cancellationDependencies?: BrowserTurnCancellationDependencies;\n}")
# Add parser/helpers before boundedDiagnostics.
replace_once(flow, "function boundedDiagnostics(input: Record<string, unknown>): Record<string, unknown> {", """function parseCancellationReceiptLine(line: string): BrowserTurnCancellationReceipt | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return parseBrowserTurnCancellationReceipt(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

async function runChildEofCancellation(
  config: LaunchConfig,
  capture: CandidateCapture,
): Promise<BrowserTurnCancellationAttempt> {
  const receipt = capture.cancellationReceipt;
  if (!receipt) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_cancellation_receipt_missing',
      stopOutcome: 'unavailable',
      identityProven: false,
    };
  }
  if (capture.duplicateCancellationReceipt) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_cancellation_receipt_duplicate',
      sendCount: 1,
      stopOutcome: 'unavailable',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
    };
  }

  const childOptions = parseFlagArgv(config.childArgs);
  const cdp = childOptions.get('cdp');
  const profile = childOptions.get('profile');
  const invocation = childOptions.get('invocation-id');
  if (typeof cdp !== 'string' || !cdp.trim()) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_cdp_unavailable',
      sendCount: 1,
      stopOutcome: 'unavailable',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
    };
  }
  if (typeof invocation === 'string' && invocation !== receipt.invocation_id) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_invocation_mismatch',
      sendCount: 1,
      stopOutcome: 'unavailable',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
    };
  }
  if (
    typeof profile === 'string'
    && configuredProfileKey(profile, cdp) !== receipt.configured_profile_key
  ) {
    return {
      state: 'driver_error',
      cause: 'child_stdout_eof_timeout_profile_mismatch',
      sendCount: 1,
      stopOutcome: 'unavailable',
      identityProven: false,
      conversationUrl: receipt.conversation_url,
    };
  }
  return await cancelOwnedGenerationFromReceipt(
    receipt,
    cdp,
    config.cancellationDependencies,
  );
}

function cancellationDiagnostics(
  attempt: BrowserTurnCancellationAttempt,
  heartbeatDiagnostics: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return boundedDiagnostics({
    ...(heartbeatDiagnostics ? { last_heartbeat: heartbeatDiagnostics } : {}),
    cancellation: {
      state: attempt.state,
      cause: attempt.cause,
      stop_outcome: attempt.stopOutcome,
      identity_proven: attempt.identityProven,
    },
  });
}

function boundedDiagnostics(input: Record<string, unknown>): Record<string, unknown> {""")
replace_once(flow, "  const capture: CandidateCapture = {\n    firstCandidate: null,\n    duplicateCandidate: false,", "  const capture: CandidateCapture = {\n    firstCandidate: null,\n    duplicateCandidate: false,\n    cancellationReceipt: null,\n    duplicateCancellationReceipt: false,")
replace_once(flow, "  const ingestStdoutLine = (line: string): void => {\n    const heartbeat = parseHeartbeat(line);", "  const ingestStdoutLine = (line: string): void => {\n    const cancellationReceipt = parseCancellationReceiptLine(line);\n    if (cancellationReceipt) {\n      if (!capture.cancellationReceipt) capture.cancellationReceipt = cancellationReceipt;\n      else capture.duplicateCancellationReceipt = true;\n      return;\n    }\n    const heartbeat = parseHeartbeat(line);")
# Replace exited-without-candidate incident block with conditional handshake.
old_missing = """    const spawnFailed = completion.result?.outcome === 'spawn-failure';
    const incident = !completion.completed
      ? 'child_stdout_eof_timeout'
      : spawnFailed
        ? 'child_start_failed'
        : 'child_terminal_result_missing';
    await publishEnvelope(config, {
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'incident',
      incident,
      delivery: deliveryWithoutTurnResult(spawnFailed),
      child_exit_code: childExitCode,
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
