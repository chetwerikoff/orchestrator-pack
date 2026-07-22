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

    location_class_end = '''        public sealed class SelfArchitectBlockLocation
        {
            public string file;
            public int startLine;
            public int endLine;
            public int lineCount;
        }

'''
    paired_class = '''        public sealed class SelfArchitectPairedMatch
        {
            public int si;
            public int ti;
            public int size;
            public int matching;
            public double overlapRatio;
        }

'''
    lint = replace_once(
        lint,
        location_class_end,
        location_class_end + paired_class,
        "paired result class",
    )

    method_marker = '''            private static void AddWindows(
'''
    paired_method = r'''            public static SelfArchitectPairedMatch FindBestPairedMatch(
                object scriptValue,
                object templateValue,
                int size,
                int stride,
                int overlapMin,
                double overlapRatioMin)
            {
                string[] scriptLines = ToLines(scriptValue);
                string[] templateLines = ToLines(templateValue);
                if (size <= 0 || scriptLines.Length < size || templateLines.Length < size)
                {
                    return null;
                }
                if (stride < 1) { stride = 1; }

                SelfArchitectPairedMatch best = null;
                for (int si = 0; si <= scriptLines.Length - size; si += stride)
                {
                    for (int ti = 0; ti <= templateLines.Length - size; ti += stride)
                    {
                        int matching = 0;
                        for (int k = 0; k < size; k++)
                        {
                            if (string.Equals(scriptLines[si + k], templateLines[ti + k], StringComparison.Ordinal))
                            {
                                matching++;
                            }
                        }

                        if (matching < overlapMin || matching == size) { continue; }
                        double overlapRatio = (double)matching / size;
                        if (overlapRatio < overlapRatioMin) { continue; }
                        if (best == null || overlapRatio > best.overlapRatio)
                        {
                            best = new SelfArchitectPairedMatch
                            {
                                si = si,
                                ti = ti,
                                size = size,
                                matching = matching,
                                overlapRatio = overlapRatio
                            };
                        }
                    }
                }
                return best;
            }

'''
    lint = replace_once(
        lint,
        method_marker,
        textwrap.dedent(paired_method) + method_marker,
        "compiled paired method",
    )

    old_loop = '''            $bestMatch = $null
            for ($si = 0; $si -le ($scriptLines.Count - $size); $si += $stride) {
                for ($ti = 0; $ti -le ($templateLines.Count - $size); $ti += $stride) {
                    $matching = 0
                    for ($k = 0; $k -lt $size; $k++) {
                        if ($scriptLines[$si + $k] -eq $templateLines[$ti + $k]) {
                            $matching++
                        }
                    }

                    if ($matching -lt $overlapMin) { continue }

                    $overlapRatio = [double]$matching / $size
                    if ($overlapRatio -lt $overlapRatioMin) { continue }
                    if ($matching -eq $size) { continue }

                    if (-not $bestMatch -or $overlapRatio -gt $bestMatch.overlapRatio) {
                        $bestMatch = [pscustomobject]@{
                            si           = $si
                            ti           = $ti
                            size         = $size
                            matching     = $matching
                            overlapRatio = $overlapRatio
                        }
                    }
                }
            }
'''
    new_loop = '''            Initialize-SelfArchitectExactBlockIndexer
            $bestMatch = [OrchestratorPack.SelfArchitectExactBlockIndexer]::FindBestPairedMatch(
                $scriptLines,
                $templateLines,
                $size,
                $stride,
                $overlapMin,
                $overlapRatioMin
            )
'''
    lint = replace_once(lint, old_loop, new_loop, "paired PowerShell hot loop")
    lint_path.write_text(lint, encoding="utf-8")

    tests_path = Path("tests/powershell/Lint-SelfArchitect.Tests.ps1")
    tests = tests_path.read_text(encoding="utf-8")
    addition = r'''

    It 'evaluates paired-edit windows in compiled code with the same best-match contract' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $pairedStart = $source.IndexOf('function Find-PairedEditFindings')
        $pairedEnd = $source.IndexOf('function Write-FindingLine')
        $pairedStart | Should -BeGreaterOrEqual 0
        $pairedEnd | Should -BeGreaterThan $pairedStart
        $pairedBody = $source.Substring($pairedStart, $pairedEnd - $pairedStart)

        $source | Should -Match 'class SelfArchitectPairedMatch'
        $source | Should -Match 'FindBestPairedMatch'
        $source | Should -Match 'overlapRatio > best\.overlapRatio'
        $pairedBody | Should -Match 'SelfArchitectExactBlockIndexer\]::FindBestPairedMatch'
        $pairedBody | Should -Not -Match 'for \(\$si = 0'
        $pairedBody | Should -Not -Match 'for \(\$ti = 0'
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
