from pathlib import Path
from subprocess import check_output

base = check_output([
    'git',
    'show',
    'ff2ccd43f3941607821f8227a3c6dfbe895bb1b2:scripts/chatgpt-browser-turn/apply-1283-production-tests.py',
], text=True)
exec(compile(base, 'apply-1283-production-tests-base.py', 'exec'))

path = Path('scripts/chatgpt-browser-turn/state-light-fresh-conversation.test.ts')
text = path.read_text()
old = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  return {\n    ...mock,\n    productStatusText: mocks.productStatusText,\n  };"
new = "  const mock = buildUiAdapterTestMock(actual, mocks);\n  const selectors = await import('./product-page-selectors.ts');\n  return {\n    ...mock,\n    ...selectors,\n    productStatusText: mocks.productStatusText,\n  };"
if text.count(old) != 1:
    raise SystemExit(f'expected one ui-adapter mock anchor, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
