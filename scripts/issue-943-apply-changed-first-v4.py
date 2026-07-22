from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def replace_function(source: str, name: str, next_name: str, replacement: str) -> str:
    start_marker = f"function {name} {{"
    end_marker = f"function {next_name} {{"
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    body = textwrap.dedent(replacement).strip("\n") + "\n\n"
    return source[:start] + body + source[end:]


def main() -> None:
    source_workflow = Path(os.environ["SOURCE_WORKFLOW"])
    workflow = source_workflow.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(workflow) if line.strip() == "python3 <<'PY'") + 1
    end = next(i for i in range(start, len(workflow)) if workflow[i].strip() == "PY")
    script = textwrap.dedent("\n".join(workflow[start:end])) + "\n"
    exec(compile(script, "<changed-first-patch>", "exec"), {"__name__": "__main__"})

    lint_path = Path("scripts/lint-self-architect.ps1")
    lint = lint_path.read_text(encoding="utf-8")
    lint = replace_function(
        lint,
        "Read-TextLines",
        "Get-FileKind",
        r'''
        function Read-TextLines {
            param([string]$FullPath)

            if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
                return @()
            }

            $lines = [System.IO.File]::ReadAllLines($FullPath, [System.Text.Encoding]::UTF8)
            for ($index = 0; $index -lt $lines.Count; $index++) {
                $lines[$index] = $lines[$index].TrimEnd()
            }
            return $lines
        }
        ''',
    )
    lint = replace_function(
        lint,
        "Add-SlidingBlockLocations",
        "Find-DuplicateLiteralFindings",
        r'''
        function Add-SlidingBlockLocations {
            param(
                [string[]]$Lines,
                [int]$Size,
                [string]$RelativePath,
                [object]$BlockMap,
                [object]$CandidateEdges,
                [switch]$ExistingKeysOnly
            )

            if ($Lines.Count -lt $Size) { return }
            $middleOffset = [int][Math]::Floor($Size / 2)

            if ($ExistingKeysOnly) {
                # Changed blocks are already known to be meaningful. Probe unchanged
                # windows by three exact anchors before allocating the full block text.
                for ($start = 0; $start -le ($Lines.Count - $Size); $start++) {
                    $firstLine = [string]$Lines[$start]
                    if (-not $CandidateEdges.ContainsKey($firstLine)) { continue }
                    $middleMap = $CandidateEdges[$firstLine]
                    $middleLine = [string]$Lines[$start + $middleOffset]
                    if (-not $middleMap.ContainsKey($middleLine)) { continue }
                    $lastLine = [string]$Lines[$start + $Size - 1]
                    $lastLines = $middleMap[$middleLine]
                    if (-not $lastLines.Contains($lastLine)) { continue }

                    $blockKey = [string]::Join("`n", $Lines, $start, $Size)
                    if (-not $BlockMap.ContainsKey($blockKey)) { continue }
                    $BlockMap[$blockKey].Add([pscustomobject]@{
                            file      = $RelativePath
                            startLine = $start + 1
                            endLine   = $start + $Size
                            lineCount = $Size
                        })
                }
                return
            }

            $meaningfulPrefix = [int[]]::new($Lines.Count + 1)
            for ($index = 0; $index -lt $Lines.Count; $index++) {
                $meaningfulPrefix[$index + 1] = $meaningfulPrefix[$index]
                if ($Lines[$index] -match '\S') {
                    $meaningfulPrefix[$index + 1]++
                }
            }

            for ($start = 0; $start -le ($Lines.Count - $Size); $start++) {
                $endExclusive = $start + $Size
                if (($meaningfulPrefix[$endExclusive] - $meaningfulPrefix[$start]) -eq 0) {
                    continue
                }

                $blockKey = [string]::Join("`n", $Lines, $start, $Size)
                if (-not $BlockMap.ContainsKey($blockKey)) {
                    $BlockMap[$blockKey] = New-Object System.Collections.Generic.List[object]
                }
                $firstLine = [string]$Lines[$start]
                $middleLine = [string]$Lines[$start + $middleOffset]
                $lastLine = [string]$Lines[$endExclusive - 1]
                if (-not $CandidateEdges.ContainsKey($firstLine)) {
                    $CandidateEdges[$firstLine] = New-Object 'System.Collections.Generic.Dictionary[string, object]' ([System.StringComparer]::Ordinal)
                }
                $middleMap = $CandidateEdges[$firstLine]
                if (-not $middleMap.ContainsKey($middleLine)) {
                    $middleMap[$middleLine] = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
                }
                [void]$middleMap[$middleLine].Add($lastLine)
                $BlockMap[$blockKey].Add([pscustomobject]@{
                        file      = $RelativePath
                        startLine = $start + 1
                        endLine   = $endExclusive
                        lineCount = $Size
                    })
            }
        }
        ''',
    )
    lint = replace_once(
        lint,
        "    $candidateEdges = @{}\n",
        "    $candidateEdges = New-Object 'System.Collections.Generic.Dictionary[string, object]' ([System.StringComparer]::Ordinal)\n",
        "ordinal candidate edge dictionary",
    )
    old_group = """    foreach ($pair in $blockMap.GetEnumerator()) {
        $locations = @($pair.Value | Sort-Object file, startLine)
        $distinctFiles = @($locations | Select-Object -ExpandProperty file -Unique)
        if ($distinctFiles.Count -lt 2) { continue }
"""
    new_group = """    foreach ($pair in $blockMap.GetEnumerator()) {
        $rawLocations = $pair.Value
        if ($rawLocations.Count -lt 2) { continue }
        $distinctFileSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($location in $rawLocations) {
            [void]$distinctFileSet.Add([string]$location.file)
        }
        if ($distinctFileSet.Count -lt 2) { continue }
        $locations = @($rawLocations | Sort-Object file, startLine)
        $distinctFiles = @($distinctFileSet)
"""
    lint = replace_once(lint, old_group, new_group, "singleton duplicate group")
    lint_path.write_text(lint, encoding="utf-8")

    tests_path = Path("tests/powershell/Lint-SelfArchitect.Tests.ps1")
    tests = tests_path.read_text(encoding="utf-8")
    tests = replace_once(
        tests,
        "        $noveltyIndex = $body.IndexOf('if ($requireIntroduced)')\n",
        "        $noveltyIndex = $body.IndexOf('Test-IsBlockNovelAtPath')\n",
        "novelty marker",
    )
    tests = replace_once(
        tests,
        "        $duplicateBody | Should -Not -Match 'ToBase64String'\n"
        "        $duplicateBody | Should -Match '\\$blockKey\\s*=\\s*\\[string\\]\\$block\\.text'\n",
        "        $duplicateBody | Should -Not -Match 'ToBase64String'\n"
        "        $helperStart = $source.IndexOf('function Add-SlidingBlockLocations')\n"
        "        $helperEnd = $source.IndexOf('function Find-DuplicateLiteralFindings')\n"
        "        $helperStart | Should -BeGreaterOrEqual 0\n"
        "        $helperEnd | Should -BeGreaterThan $helperStart\n"
        "        $helperBody = $source.Substring($helperStart, $helperEnd - $helperStart)\n"
        "        $helperBody | Should -Not -Match 'ToBase64String'\n"
        "        $helperBody | Should -Match '\\$blockKey\\s*=\\s*\\[string\\]::Join'\n",
        "changed-first key location",
    )
    addition = r'''

    It 'skips singleton duplicate groups before sorting locations' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $finderStart = $source.IndexOf('function Find-DuplicateLiteralFindings')
        $finderEnd = $source.IndexOf('function Find-HeuristicDuplicateFindings')
        $finderStart | Should -BeGreaterOrEqual 0
        $finderEnd | Should -BeGreaterThan $finderStart
        $finderBody = $source.Substring($finderStart, $finderEnd - $finderStart)

        $singletonIndex = $finderBody.IndexOf('if ($rawLocations.Count -lt 2)')
        $sortIndex = $finderBody.IndexOf('$locations = @($rawLocations | Sort-Object file, startLine)')
        $singletonIndex | Should -BeGreaterOrEqual 0
        $singletonIndex | Should -BeLessThan $sortIndex
        $finderBody | Should -Match 'System\.Collections\.Generic\.HashSet\[string\]'
    }

    It 'probes unchanged windows with exact first middle and last anchors' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $helperStart = $source.IndexOf('function Add-SlidingBlockLocations')
        $helperEnd = $source.IndexOf('function Find-DuplicateLiteralFindings')
        $helperBody = $source.Substring($helperStart, $helperEnd - $helperStart)
        $existingStart = $helperBody.IndexOf('if ($ExistingKeysOnly)')
        $prefixStart = $helperBody.IndexOf('$meaningfulPrefix')

        $existingStart | Should -BeGreaterOrEqual 0
        $existingStart | Should -BeLessThan $prefixStart
        $helperBody | Should -Match '\$middleOffset'
        $helperBody | Should -Match '\$middleMap\.ContainsKey\(\$middleLine\)'
        $helperBody | Should -Match '\$lastLines\.Contains\(\$lastLine\)'
        $helperBody | Should -Match 'Dictionary\[string, object\]'
    }

    It 'reads and trims corpus lines without a per-file PowerShell pipeline' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $readStart = $source.IndexOf('function Read-TextLines')
        $readEnd = $source.IndexOf('function Get-FileKind')
        $readBody = $source.Substring($readStart, $readEnd - $readStart)

        $readBody | Should -Match 'System\.IO\.File\]::ReadAllLines'
        $readBody | Should -Not -Match 'ForEach-Object'
        $readBody | Should -Match '\.TrimEnd\(\)'
    }
'''
    marker = "\n}\n"
    insert_at = tests.rfind(marker)
    if insert_at < 0:
        raise SystemExit("pester closing marker missing")
    tests = tests[:insert_at] + textwrap.dedent(addition) + tests[insert_at:]
    tests_path.write_text(tests, encoding="utf-8")

    expected = sorted(
        [
            "scripts/lint-self-architect.ps1",
            "tests/powershell/Lint-SelfArchitect.Tests.ps1",
        ]
    )
    actual = sorted(
        subprocess.check_output(["git", "diff", "--name-only"], text=True).splitlines()
    )
    print("expected_paths=", expected)
    print("actual_paths=", actual)
    if actual != expected:
        raise SystemExit(f"changed_path_mismatch:{actual}")
    check = subprocess.run(["git", "diff", "--check"], text=True, capture_output=True)
    print("diff_check_stdout=", check.stdout)
    print("diff_check_stderr=", check.stderr)
    if check.returncode != 0:
        raise SystemExit(f"diff_check_failed:{check.returncode}")


if __name__ == "__main__":
    main()
