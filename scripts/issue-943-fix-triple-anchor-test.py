from pathlib import Path

path = Path('tests/powershell/Lint-SelfArchitect.Tests.ps1')
source = path.read_text(encoding='utf-8')
old = "        $helperBody | Should -Match '\\$ExistingKeysOnly -and -not \\$BlockMap\\.ContainsKey'\n"
new = "        $helperBody | Should -Match 'if \\(-not \\$BlockMap\\.ContainsKey\\(\\$blockKey\\)\\)'\n"
count = source.count(old)
if count != 1:
    raise SystemExit(f'triple-anchor structural expectation: expected one match, found {count}')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
