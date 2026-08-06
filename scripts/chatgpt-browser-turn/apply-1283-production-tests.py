from pathlib import Path
from subprocess import check_output

base = check_output([
    'git',
    'show',
    'd4846a3e3e24bdc5e53bd8c1fb146ca79da2becc:scripts/chatgpt-browser-turn/apply-1283-production-tests.py',
], text=True)
exec(compile(base, 'apply-1283-production-tests-base.py', 'exec'))

path = Path('scripts/chatgpt-browser-turn/state-light-fresh-conversation.test.ts')
text = path.read_text()
text = text.replace(
    "import { classifyPageObservation, classifySendLandingEvidence, runStateLightTurn } from './state-light-turn.ts';",
    "import { classifyPageObservation, classifySendLandingEvidence, runStateLightTurn } from './state-light-turn.ts';\n"
    "import { readRecoveryAuthoritativeUserMessages, stopOwnedGeneration } from './state-light-cancellation.ts';",
    1,
)
text = text.replace(
    "    const initialBrowser = browserWithPages(initialPage, [initialPage], () => !lost);",
    "    expect(await readRecoveryAuthoritativeUserMessages(recoveredPage)).toMatchObject({ incomplete: false });\n"
    "    expect(await readRecoveryAuthoritativeUserMessages(foreignPage)).toMatchObject({ incomplete: false });\n\n"
    "    const initialBrowser = browserWithPages(initialPage, [initialPage], () => !lost);",
    1,
)
text = text.replace(
    "    mocks.browserQueue.push(browserWithPages(ownedPage, [ownedPage, foreignPage], () => true));",
    "    const stopProbeClick = vi.fn(async () => undefined);\n"
    "    const stopProbePage = {\n"
    "      isClosed: vi.fn(() => false),\n"
    "      locator: vi.fn((selector: string) => matchesStopButtonSelector(selector)\n"
    "        ? scalarLocator({\n"
    "          count: vi.fn()\n"
    "            .mockResolvedValueOnce(1)\n"
    "            .mockResolvedValueOnce(0),\n"
    "          click: stopProbeClick,\n"
    "        })\n"
    "        : scalarLocator()),\n"
    "    };\n"
    "    expect(await stopOwnedGeneration(stopProbePage)).toBe('confirmed');\n"
    "    expect(stopProbeClick).toHaveBeenCalledTimes(1);\n\n"
    "    mocks.browserQueue.push(browserWithPages(ownedPage, [ownedPage, foreignPage], () => true));",
    1,
)
text = text.replace(
    "    expect(ownedStop).toHaveBeenCalledTimes(1);",
    "    expect(ownedStop, JSON.stringify(outcome)).toHaveBeenCalledTimes(1);",
    1,
)
path.write_text(text)
