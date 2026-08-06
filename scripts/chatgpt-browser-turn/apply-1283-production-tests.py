from pathlib import Path
from subprocess import check_output

base = check_output([
    'git',
    'show',
    'ff2ccd43f3941607821f8227a3c6dfbe895bb1b2:scripts/chatgpt-browser-turn/apply-1283-production-tests.py',
], text=True)
exec(compile(base, 'apply-1283-production-tests-base.py', 'exec'))

cancellation = Path('scripts/chatgpt-browser-turn/state-light-cancellation.ts')
cancellation_text = cancellation.read_text()
old_import = (
    "import {\n"
    "  loadChromium,\n"
    "  normalizeConversationUrl,\n"
    "  STOP_BUTTON_SELECTOR,\n"
    "  USER_MESSAGE_SELECTOR,\n"
    "} from './ui-adapter.ts';"
)
new_import = (
    "import { STOP_BUTTON_SELECTOR, USER_MESSAGE_SELECTOR } from './product-page-selectors.ts';\n"
    "import { loadChromium, normalizeConversationUrl } from './ui-adapter.ts';"
)
if old_import in cancellation_text:
    cancellation.write_text(cancellation_text.replace(old_import, new_import, 1))
elif new_import not in cancellation_text:
    raise SystemExit('cancellation selector import is neither old nor expected new form')

path = Path('scripts/chatgpt-browser-turn/state-light-fresh-conversation.test.ts')
text = path.read_text()
old_mock = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  return {\n    ...mock,\n    productStatusText: mocks.productStatusText,\n  };"
new_mock = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  const selectors = await import('./product-page-selectors.ts');\n  return {\n    ...mock,\n    ...selectors,\n    productStatusText: mocks.productStatusText,\n  };"
if old_mock in text:
    text = text.replace(old_mock, new_mock, 1)
elif new_mock not in text:
    raise SystemExit('ui-adapter mock is neither old nor expected new form')

old_selector_import = (
    "  COMPOSER_SELECTOR,\n"
    "  matchesNewChatControlSelector,\n"
    "  MESSAGE_NODE_SELECTOR,\n"
    "  SEND_BUTTON_SELECTOR,\n"
    "  STOP_BUTTON_TESTID,\n"
    "} from './product-page-selectors.ts';"
)
new_selector_import = (
    "  COMPOSER_SELECTOR,\n"
    "  matchesNewChatControlSelector,\n"
    "  matchesStopButtonSelector,\n"
    "  MESSAGE_NODE_SELECTOR,\n"
    "  SEND_BUTTON_SELECTOR,\n"
    "  STOP_BUTTON_TESTID,\n"
    "  USER_MESSAGE_SELECTOR,\n"
    "} from './product-page-selectors.ts';"
)
if old_selector_import in text:
    text = text.replace(old_selector_import, new_selector_import, 1)
elif new_selector_import not in text:
    raise SystemExit('product selector imports are neither old nor expected new form')

stale_success_incident_assertion = (
    "    expect(outcome.result.incidents).toContain('post_send_recovery_succeeded');\n"
)
if stale_success_incident_assertion in text:
    text = text.replace(stale_success_incident_assertion, '', 1)

mocked_publication_file_assertion = "    expect(readFileSync(output, 'utf8')).toBe(reply);\n"
truthful_terminal_output_assertion = (
    "    expect(outcome.result.output).toEqual({\n"
    "      byte_length: 15,\n"
    "      sha256: '574877027739d7ff52e587b7003cf11b863f623083bb43607417c82cc38cfd8b',\n"
    "    });\n"
)
if mocked_publication_file_assertion in text:
    text = text.replace(mocked_publication_file_assertion, truthful_terminal_output_assertion, 1)
elif truthful_terminal_output_assertion not in text:
    raise SystemExit('recovery output assertion is neither old nor expected new form')
path.write_text(text)
