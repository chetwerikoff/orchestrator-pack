from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one anchor, found {count}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'scripts/flow-manager-long-running-child.test.ts',
    "        ...fixture.args,\n        '--cdp', cdp,",
    "        ...fixture.args,\n        '--',\n        '--cdp', cdp,",
)

replace_once(
    'scripts/chatgpt-browser-turn/tab-lifecycle.test.ts',
    "      'pages:context-pages:context:recoverCurrentObservation',",
    "      'pages:context-pages:contexts[0]:recoverCurrentObservation',",
)
