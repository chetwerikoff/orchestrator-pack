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
old_import = "import { normalizeConversationUrl, STOP_BUTTON_SELECTOR, USER_MESSAGE_SELECTOR } from './ui-adapter.ts';"
new_import = (
    "import { STOP_BUTTON_SELECTOR, USER_MESSAGE_SELECTOR } from './product-page-selectors.ts';\n"
    "import { normalizeConversationUrl } from './ui-adapter.ts';"
)
if cancellation_text.count(old_import) != 1:
    raise SystemExit(f'expected one cancellation selector import, found {cancellation_text.count(old_import)}')
cancellation.write_text(cancellation_text.replace(old_import, new_import, 1))

path = Path('scripts/chatgpt-browser-turn/state-light-fresh-conversation.test.ts')
text = path.read_text()
old = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  return {\n    ...mock,\n    productStatusText: mocks.productStatusText,\n  };"
new = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  const selectors = await import('./product-page-selectors.ts');\n  return {\n    ...mock,\n    ...selectors,\n    productStatusText: mocks.productStatusText,\n  };"
if text.count(old) != 1:
    raise SystemExit(f'expected one ui-adapter mock anchor, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
