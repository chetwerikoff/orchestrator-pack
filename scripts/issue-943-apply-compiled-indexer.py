from __future__ import annotations

import subprocess
import textwrap
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    lint_path = Path("scripts/lint-self-architect.ps1")
    lint = lint_path.read_text(encoding="utf-8")

    compiled_helper = r'''
    function Initialize-SelfArchitectExactBlockIndexer {
        if ('OrchestratorPack.SelfArchitectExactBlockIndexer' -as [type]) { return }

        Add-Type -TypeDefinition @'
    using System;
    using System.Collections;
    using System.Collections.Generic;
    using System.Text.RegularExpressions;

    namespace OrchestratorPack
    {
        public sealed class SelfArchitectBlockLocation
        {
            public string file;
            public int startLine;
            public int endLine;
            public int lineCount;
        }

        internal struct SelfArchitectAnchorKey : IEquatable<SelfArchitectAnchorKey>
        {
            private readonly string first;
            private readonly string quarter;
            private readonly string middle;
            private readonly string last;

            public SelfArchitectAnchorKey(string[] lines, int start, int size)
            {
                first = lines[start] ?? string.Empty;
                quarter = lines[start + (size / 3)] ?? string.Empty;
                middle = lines[start + ((size * 2) / 3)] ?? string.Empty;
                last = lines[start + size - 1] ?? string.Empty;
            }

            public bool Equals(SelfArchitectAnchorKey other)
            {
                return string.Equals(first, other.first, StringComparison.Ordinal)
                    && string.Equals(quarter, other.quarter, StringComparison.Ordinal)
                    && string.Equals(middle, other.middle, StringComparison.Ordinal)
                    && string.Equals(last, other.last, StringComparison.Ordinal);
            }

            public override bool Equals(object obj)
            {
                return obj is SelfArchitectAnchorKey && Equals((SelfArchitectAnchorKey)obj);
            }

            public override int GetHashCode()
            {
                unchecked
                {
                    int hash = 17;
                    hash = (hash * 31) + StringComparer.Ordinal.GetHashCode(first);
                    hash = (hash * 31) + StringComparer.Ordinal.GetHashCode(quarter);
                    hash = (hash * 31) + StringComparer.Ordinal.GetHashCode(middle);
                    hash = (hash * 31) + StringComparer.Ordinal.GetHashCode(last);
                    return hash;
                }
            }
        }

        public static class SelfArchitectExactBlockIndexer
        {
            private static readonly Regex MeaningfulLine = new Regex(@"\S", RegexOptions.CultureInvariant);

            public static Dictionary<string, List<SelfArchitectBlockLocation>> Build(
                IDictionary fileLines,
                IEnumerable introducedPaths,
                int size)
            {
                var changed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (introducedPaths != null)
                {
                    var onePath = introducedPaths as string;
                    if (onePath != null)
                    {
                        changed.Add(NormalizePath(onePath));
                    }
                    else
                    {
                        foreach (object item in introducedPaths)
                        {
                            if (item != null)
                            {
                                changed.Add(NormalizePath(item.ToString()));
                            }
                        }
                    }
                }

                var blockMap = new Dictionary<string, List<SelfArchitectBlockLocation>>(StringComparer.Ordinal);
                var anchors = new HashSet<SelfArchitectAnchorKey>();
                bool requireChanged = changed.Count > 0;

                if (requireChanged)
                {
                    foreach (DictionaryEntry entry in fileLines)
                    {
                        string path = NormalizePath(entry.Key == null ? string.Empty : entry.Key.ToString());
                        if (!changed.Contains(path)) { continue; }
                        AddWindows(ToLines(entry.Value), size, path, blockMap, anchors, false);
                    }

                    if (blockMap.Count > 0)
                    {
                        foreach (DictionaryEntry entry in fileLines)
                        {
                            string path = NormalizePath(entry.Key == null ? string.Empty : entry.Key.ToString());
                            if (changed.Contains(path)) { continue; }
                            AddWindows(ToLines(entry.Value), size, path, blockMap, anchors, true);
                        }
                    }
                }
                else
                {
                    foreach (DictionaryEntry entry in fileLines)
                    {
                        string path = NormalizePath(entry.Key == null ? string.Empty : entry.Key.ToString());
                        AddWindows(ToLines(entry.Value), size, path, blockMap, anchors, false);
                    }
                }

                return blockMap;
            }

            private static void AddWindows(
                string[] lines,
                int size,
                string path,
                Dictionary<string, List<SelfArchitectBlockLocation>> blockMap,
                HashSet<SelfArchitectAnchorKey> anchors,
                bool existingKeysOnly)
            {
                if (size <= 0 || lines.Length < size) { return; }

                int[] meaningfulPrefix = null;
                if (!existingKeysOnly)
                {
                    meaningfulPrefix = new int[lines.Length + 1];
                    for (int index = 0; index < lines.Length; index++)
                    {
                        meaningfulPrefix[index + 1] = meaningfulPrefix[index];
                        if (MeaningfulLine.IsMatch(lines[index] ?? string.Empty))
                        {
                            meaningfulPrefix[index + 1]++;
                        }
                    }
                }

                for (int start = 0; start <= lines.Length - size; start++)
                {
                    if (!existingKeysOnly && meaningfulPrefix[start + size] == meaningfulPrefix[start])
                    {
                        continue;
                    }

                    var anchor = new SelfArchitectAnchorKey(lines, start, size);
                    if (existingKeysOnly && !anchors.Contains(anchor)) { continue; }

                    string blockText = string.Join("\n", lines, start, size);
                    List<SelfArchitectBlockLocation> locations;
                    if (existingKeysOnly)
                    {
                        if (!blockMap.TryGetValue(blockText, out locations)) { continue; }
                    }
                    else
                    {
                        if (!blockMap.TryGetValue(blockText, out locations))
                        {
                            locations = new List<SelfArchitectBlockLocation>();
                            blockMap.Add(blockText, locations);
                        }
                        anchors.Add(anchor);
                    }

                    locations.Add(new SelfArchitectBlockLocation
                    {
                        file = path,
                        startLine = start + 1,
                        endLine = start + size,
                        lineCount = size
                    });
                }
            }

            private static string[] ToLines(object value)
            {
                var typed = value as string[];
                if (typed != null) { return typed; }

                var list = value as IList;
                if (list != null)
                {
                    var lines = new string[list.Count];
                    for (int index = 0; index < list.Count; index++)
                    {
                        lines[index] = list[index] == null ? string.Empty : list[index].ToString();
                    }
                    return lines;
                }

                var enumerable = value as IEnumerable;
                if (enumerable == null) { return new string[0]; }
                var collected = new List<string>();
                foreach (object item in enumerable)
                {
                    collected.Add(item == null ? string.Empty : item.ToString());
                }
                return collected.ToArray();
            }

            private static string NormalizePath(string path)
            {
                return (path ?? string.Empty).Replace('\\', '/').TrimStart('.', '/');
            }
        }
    }
    '@
    }

    '''
    insert_marker = "function Get-SlidingBlocks {\n"
    if lint.count(insert_marker) != 1:
        raise SystemExit(f"compiled helper insertion marker count: {lint.count(insert_marker)}")
    lint = lint.replace(insert_marker, textwrap.dedent(compiled_helper).lstrip() + insert_marker, 1)

    old_index = """    $blockMap = New-Object 'System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[object]]'
    $introduced = @{}
    foreach ($path in $IntroducedInPaths) {
        if ($path) {
            $introduced[(Normalize-RepoPath $path).ToLowerInvariant()] = $true
        }
    }
    $requireIntroduced = ($introduced.Count -gt 0)
    $baseLinesCache = @{}
    $baseBlockCache = @{}

    foreach ($entry in $FileLines.GetEnumerator()) {
        $relativePath = $entry.Key
        $blocks = Get-SlidingBlocks -Lines $entry.Value -Size $minStrict
        foreach ($block in $blocks) {
            $blockKey = [string]$block.text
            if (-not $blockMap.ContainsKey($blockKey)) {
                $blockMap[$blockKey] = New-Object System.Collections.Generic.List[object]
            }
            $blockMap[$blockKey].Add([pscustomobject]@{
                    file      = $relativePath
                    startLine = $block.startLine
                    endLine   = $block.endLine
                    lineCount = $block.lineCount
                })
        }
    }
"""
    new_index = """    $introduced = @{}
    foreach ($path in $IntroducedInPaths) {
        if ($path) {
            $introduced[(Normalize-RepoPath $path).ToLowerInvariant()] = $true
        }
    }
    $requireIntroduced = ($introduced.Count -gt 0)
    $baseLinesCache = @{}
    $baseBlockCache = @{}

    Initialize-SelfArchitectExactBlockIndexer
    $blockMap = [OrchestratorPack.SelfArchitectExactBlockIndexer]::Build(
        $FileLines,
        $IntroducedInPaths,
        $minStrict
    )
"""
    lint = replace_once(lint, old_index, new_index, "compiled index invocation")
    lint_path.write_text(lint, encoding="utf-8")

    tests_path = Path("tests/powershell/Lint-SelfArchitect.Tests.ps1")
    tests = tests_path.read_text(encoding="utf-8")
    tests = replace_once(
        tests,
        "        $duplicateBody | Should -Not -Match 'ToBase64String'\n"
        "        $duplicateBody | Should -Match '\\$blockKey\\s*=\\s*\\[string\\]\\$block\\.text'\n",
        "        $source | Should -Not -Match 'ToBase64String'\n"
        "        $source | Should -Match 'SelfArchitectExactBlockIndexer'\n"
        "        $source | Should -Match 'HashSet<SelfArchitectAnchorKey>'\n"
        "        $duplicateBody | Should -Match 'SelfArchitectExactBlockIndexer\\]::Build'\n"
        "        $duplicateBody | Should -Not -Match 'Get-SlidingBlocks -Lines \\$entry\\.Value'\n",
        "compiled structural expectations",
    )

    addition = r'''

    It 'uses compiled exact candidate indexing with full-string verification' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $helperStart = $source.IndexOf('function Initialize-SelfArchitectExactBlockIndexer')
        $helperEnd = $source.IndexOf('function Get-SlidingBlocks')
        $helperStart | Should -BeGreaterOrEqual 0
        $helperEnd | Should -BeGreaterThan $helperStart
        $helperBody = $source.Substring($helperStart, $helperEnd - $helperStart)

        $helperBody | Should -Match 'Add-Type -TypeDefinition'
        $helperBody | Should -Match 'HashSet<SelfArchitectAnchorKey>'
        $helperBody | Should -Match 'string\.Join\("\\n", lines, start, size\)'
        $helperBody | Should -Match 'blockMap\.TryGetValue\(blockText, out locations\)'
        $helperBody | Should -Match 'StringComparison\.Ordinal'
        $helperBody | Should -Not -Match 'ToBase64String'
    }
'''
    marker = "\n}\n"
    insert_at = tests.rfind(marker)
    if insert_at < 0:
        raise SystemExit("Pester closing marker missing")
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
