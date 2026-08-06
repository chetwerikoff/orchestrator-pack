from subprocess import check_output

source = check_output([
    'git',
    'show',
    '678c281ec52cb8eafc38b9fa3af1e7f76d068573:scripts/chatgpt-browser-turn/apply-1283-production-tests.py',
], text=True)
start = source.index('flow_test =')
end = source.index('support =')
source = source[:start] + source[end:]
source = source.replace(
    "describe('Issue #1283 production runStateLightTurn recovery integration', () => {\n  function browserWithPages(",
    "describe('Issue #1283 production runStateLightTurn recovery integration', () => {\n"
    "  let integrationStateDir: string;\n\n"
    "  beforeEach(() => {\n"
    "    integrationStateDir = mkdtempSync(join(tmpdir(), 'slt-recovery-'));\n"
    "    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = integrationStateDir;\n"
    "    disableSendSlotForTest();\n"
    "    mocks.browserQueue.length = 0;\n"
    "    mocks.cleanupOutcome = 'confirmed';\n"
    "    mocks.nowMs = 10_000;\n"
    "    mocks.productStatusText.mockReset();\n"
    "    mocks.productStatusText.mockResolvedValue({ text: '', composer: true });\n"
    "    mocks.readStableInput.mockReset();\n"
    "    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);\n"
    "  });\n\n"
    "  afterEach(() => {\n"
    "    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;\n"
    "    clearSendSlotDisableEnv();\n"
    "    rmSync(integrationStateDir, { recursive: true, force: true });\n"
    "    vi.restoreAllMocks();\n"
    "  });\n\n"
    "  function browserWithPages(",
)
source = source.replace("join(stateDir, 'recovered.txt')", "join(integrationStateDir, 'recovered.txt')")
source = source.replace("join(stateDir, 'exhausted.txt')", "join(integrationStateDir, 'exhausted.txt')")
source = source.replace(
    "  matchesNewChatControlSelector,\n  MESSAGE_NODE_SELECTOR,",
    "  matchesNewChatControlSelector,\n  matchesStopButtonSelector,\n  MESSAGE_NODE_SELECTOR,",
)
source = source.replace(
    "const recoveredMessages = readyTurnObservationFrames(prompt, reply).at(-1)!;",
    "const recoveredMessages = (): StateLightTestMessage[] => [\n"
    "      { role: 'user', text: composerText },\n"
    "      {\n"
    "        role: 'assistant',\n"
    "        text: reply,\n"
    "        finalAction: true,\n"
    "        finalActionInTurnContainer: true,\n"
    "      },\n"
    "    ];",
)
source = source.replace("collectionLocator(recoveredMessages, false)", "collectionLocator(recoveredMessages(), false)")
source = source.replace("recoveredMessages.filter", "recoveredMessages().filter")
source = source.replace("const last = recoveredMessages.at(-1)!;", "const last = recoveredMessages().at(-1)!;")
source = source.replace(
    "press: vi.fn(async () => { sends += 1; lost = true; }),",
    "press: vi.fn(async () => { sends += 1; initialUrl = SHARED_CONV; lost = true; }),",
)
source = source.replace(
    "click: vi.fn(async () => { sends += 1; lost = true; }),",
    "click: vi.fn(async () => { sends += 1; initialUrl = SHARED_CONV; lost = true; }),",
)
source = source.replace(
    "const waitingMessages = readyTurnObservationFrames(prompt, 'UNUSED')[0]!;",
    "const waitingMessages = (): StateLightTestMessage[] => [\n"
    "      { role: 'user', text: composerText },\n"
    "      { role: 'assistant', text: 'working', inProgress: true },\n"
    "    ];",
)
source = source.replace("collectionLocator(waitingMessages, true)", "collectionLocator(waitingMessages(), true)")
source = source.replace("waitingMessages.filter", "waitingMessages().filter")
source = source.replace("const last = waitingMessages.at(-1)!;", "const last = waitingMessages().at(-1)!;")
source = source.replace(
    "const ownedStop = vi.fn(async () => undefined);",
    "let ownedStopped = false;\n    const ownedStop = vi.fn(async () => { ownedStopped = true; });",
)
source = source.replace(
    "if (selector.includes(STOP_BUTTON_TESTID)) {\n          return scalarLocator({ count: vi.fn(async () => sent ? 1 : 0), click: ownedStop });\n        }",
    "if (matchesStopButtonSelector(selector)) {\n          return scalarLocator({\n            count: vi.fn(async () => sent && !ownedStopped ? 1 : 0),\n            click: ownedStop,\n          });\n        }",
)
source = source.replace(
    "selector.includes(STOP_BUTTON_TESTID)\n        ? scalarLocator({ count: vi.fn(async () => 1), click: foreignStop })",
    "matchesStopButtonSelector(selector)\n        ? scalarLocator({ count: vi.fn(async () => 1), click: foreignStop })",
)
source = source.replace(
    "expect(outcome.result.incidents).toContain('owned_generation_stop_completed');",
    "expect(outcome.result.incidents).toContain('owned_generation_stop_confirmed');",
)
exec(compile(source, 'apply-1283-production-tests.py', 'exec'))
