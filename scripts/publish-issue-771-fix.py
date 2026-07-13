#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = os.environ.get("GITHUB_REPOSITORY", "chetwerikoff/orchestrator-pack")
BRANCH = "agent/issue-771-powershell-scope"
TOKEN = os.environ["GH_TOKEN"]
API = "https://api.github.com"


def api(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "issue-771-publisher",
        },
    )
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} failed: {exc.code} {detail}") from exc
    return json.loads(raw) if raw else {}


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


def patch_wake(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    top_level = ". (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')\n"
    cycle = ". (Join-Path $PSScriptRoot 'Review-CycleCap.ps1')\n"
    local = "    . (Join-Path $PSScriptRoot 'Review-PostRunRetry.ps1')\n"
    if top_level not in text:
        text = replace_once(text, cycle, cycle + top_level, "wake top-level import")
    if local in text:
        text = replace_once(text, local, "", "wake function-local import")
    if text.count(top_level) != 1 or local in text:
        raise RuntimeError("wake import normalization failed")
    path.write_text(text, encoding="utf-8")


def patch_tests(path: Path) -> None:
    text = path.read_text(encoding="utf-8")

    if "$WakeTrigger =" not in text:
        anchor = "    $InvokeAo = Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1'\n"
        text = replace_once(
            text,
            anchor,
            anchor + "    $WakeTrigger = Join-Path $RepoRoot 'scripts/lib/Invoke-ReviewWakeTrigger.ps1'\n",
            "test wake path",
        )

    helper = r'''    function Test-Issue771ConsumerHasSafeScriptImporters {
        param(
            $CandidateRecord,
            $Consumer,
            [string]$ConsumerName,
            [object[]]$Records,
            [string]$RepositoryRoot,
            [hashtable]$ClosureCache
        )

        $consumerOwner = Get-Issue771OwningFunction $Consumer
        if (-not $consumerOwner) {
            return $false
        }

        $relevantImporters = @()
        foreach ($record in $Records) {
            $importsConsumerLibrary = $false
            foreach ($dotSource in @($record.Commands | Where-Object {
                        $_.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot -and
                        $null -eq (Get-Issue771OwningFunction $_)
                    })) {
                $target = Resolve-Issue771DotSourceTarget $dotSource.Extent.Text $record.Path $RepositoryRoot
                if ($target -and [IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($CandidateRecord.Path)) {
                    $importsConsumerLibrary = $true
                    break
                }
            }
            if (-not $importsConsumerLibrary) { continue }

            $callsConsumer = @($record.Commands | Where-Object {
                    $_.GetCommandName() -eq $consumerOwner.Name -and
                    -not ($record.Path -eq $CandidateRecord.Path -and (Test-Issue771Within $_ $consumerOwner))
                })
            if ($callsConsumer.Count -gt 0) {
                $relevantImporters += $record
            }
        }

        if ($relevantImporters.Count -eq 0) {
            return $false
        }
        foreach ($importer in $relevantImporters) {
            $visiting = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $available = @(Get-Issue771ScriptImportFunctionClosure -Path $importer.Path `
                    -RepositoryRoot $RepositoryRoot -Cache $ClosureCache -Visiting $visiting)
            if ($available -notcontains $ConsumerName) {
                return $false
            }
        }
        return $true
    }

'''
    if "function Test-Issue771ConsumerHasSafeScriptImporters" not in text:
        text = replace_once(
            text,
            "    function Get-Issue771DependencyScopeLeaks {\n",
            helper + "    function Get-Issue771DependencyScopeLeaks {\n",
            "parent importer helper",
        )

    old_load = r'''                                $independentLoad = Test-Issue771ConsumerHasIndependentLoad `
                                    -CandidateRecord $candidate -Consumer $consumer -ConsumerName $consumerName `
                                    -RepositoryRoot $RepositoryRoot -ClosureCache $closureCache
                                if (-not $independentLoad) {
'''
    new_load = r'''                                $independentLoad = Test-Issue771ConsumerHasIndependentLoad `
                                    -CandidateRecord $candidate -Consumer $consumer -ConsumerName $consumerName `
                                    -RepositoryRoot $RepositoryRoot -ClosureCache $closureCache
                                if (-not $independentLoad) {
                                    $independentLoad = Test-Issue771ConsumerHasSafeScriptImporters `
                                        -CandidateRecord $candidate -Consumer $consumer -ConsumerName $consumerName `
                                        -Records $records -RepositoryRoot $RepositoryRoot -ClosureCache $closureCache
                                }
                                if (-not $independentLoad) {
'''
    if "-Records $records -RepositoryRoot" not in text:
        text = replace_once(text, old_load, new_load, "parent importer invocation")

    wake_test = r'''    It 'keeps review-wake retry commands visible after snapshot loading returns' {
        $result = Invoke-Issue771Pwsh @"
. $(Quote-Issue771 $WakeTrigger)
@{
 retry=[bool](Get-Command Register-PostRunAutonomousRetryAttemptFromClaim -CommandType Function -ErrorAction SilentlyContinue)
 snapshot=[bool](Get-Command Get-ReviewWakeTriggerSnapshot -CommandType Function -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Compress
"@
        $result.retry | Should -BeTrue
        $result.snapshot | Should -BeTrue
    }

'''
    if "keeps review-wake retry commands visible" not in text:
        text = replace_once(
            text,
            "    It 'never latches an incomplete load as success or replays partial top-level effects' {\n",
            wake_test + "    It 'never latches an incomplete load as success or replays partial top-level effects' {\n",
            "wake visibility test",
        )

    parent_test = r'''    It 'accepts a consumer library whose production importer owns the dependency scope' {
        $dir = New-Issue771Temp
        try {
            Set-Content (Join-Path $dir 'Dependency.ps1') "function Invoke-ParentManagedDependency { 'ok' }"
            Set-Content (Join-Path $dir 'Loader.ps1') "function Initialize-ParentManagedDependency { . (Join-Path `$PSScriptRoot 'Dependency.ps1') }"
            Set-Content (Join-Path $dir 'ConsumerLib.ps1') "function Invoke-ParentManagedConsumer { Initialize-ParentManagedDependency; Invoke-ParentManagedDependency }"
            Set-Content (Join-Path $dir 'Entrypoint.ps1') ". (Join-Path `$PSScriptRoot 'Loader.ps1')`n. (Join-Path `$PSScriptRoot 'Dependency.ps1')`n. (Join-Path `$PSScriptRoot 'ConsumerLib.ps1')`nInvoke-ParentManagedConsumer"
            $leaks = @(Get-Issue771DependencyScopeLeaks -RepositoryRoot $dir -ScanRoot $dir)
            $leaks | Should -BeNullOrEmpty -Because ($leaks | ConvertTo-Json -Compress -Depth 8)
        }
        finally {
            Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

'''
    if "production importer owns the dependency scope" not in text:
        text = replace_once(
            text,
            "    It 'fails for an unrelated synthetic cross-file loader and consumer' {\n",
            parent_test + "    It 'fails for an unrelated synthetic cross-file loader and consumer' {\n",
            "parent importer regression test",
        )

    required = [
        "$WakeTrigger =",
        "function Test-Issue771ConsumerHasSafeScriptImporters",
        "keeps review-wake retry commands visible",
        "production importer owns the dependency scope",
    ]
    missing = [marker for marker in required if marker not in text]
    if missing:
        raise RuntimeError(f"test patch missing markers: {missing}")
    path.write_text(text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: publish-issue-771-fix.py <checkout-root>")
    root = Path(sys.argv[1]).resolve()
    wake = root / "scripts/lib/Invoke-ReviewWakeTrigger.ps1"
    tests = root / "tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1"
    patch_wake(wake)
    patch_tests(tests)

    checkout_sha = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    ref_path = f"/repos/{REPO}/git/ref/heads/{urllib.parse.quote(BRANCH, safe='')}"
    current_ref = api("GET", ref_path)
    current_sha = current_ref["object"]["sha"]
    if current_sha != checkout_sha:
        raise RuntimeError(
            f"branch drift: checkout={checkout_sha} current={current_sha}; refusing update"
        )

    current_commit = api("GET", f"/repos/{REPO}/git/commits/{current_sha}")
    entries = []
    for repo_path, local_path in (
        ("scripts/lib/Invoke-ReviewWakeTrigger.ps1", wake),
        ("tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1", tests),
    ):
        encoded = base64.b64encode(local_path.read_bytes()).decode("ascii")
        blob = api(
            "POST",
            f"/repos/{REPO}/git/blobs",
            {"content": encoded, "encoding": "base64"},
        )
        entries.append({"path": repo_path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    tree = api(
        "POST",
        f"/repos/{REPO}/git/trees",
        {"base_tree": current_commit["tree"]["sha"], "tree": entries},
    )
    commit = api(
        "POST",
        f"/repos/{REPO}/git/commits",
        {
            "message": "Fix remaining issue 771 dependency scope sites",
            "tree": tree["sha"],
            "parents": [current_sha],
        },
    )
    api(
        "PATCH",
        ref_path,
        {"sha": commit["sha"], "force": False},
    )
    print(f"UPDATED_BRANCH={BRANCH}")
    print(f"OLD_SHA={current_sha}")
    print(f"NEW_SHA={commit['sha']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
