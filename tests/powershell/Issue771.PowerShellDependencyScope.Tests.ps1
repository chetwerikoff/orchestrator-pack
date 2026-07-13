#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $WorkerStore = Join-Path $RepoRoot 'scripts/lib/WorkerStatusStore.ps1'
    $InvokeAo = Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1'

    function Quote-Issue771([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
    function New-Issue771Temp {
        $path = Join-Path ([IO.Path]::GetTempPath()) ('opk-771-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }
    function Invoke-Issue771Pwsh([string]$Command) {
        $output = @(& pwsh -NoProfile -NonInteractive -Command $Command 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "pwsh failed ($LASTEXITCODE)`n$($output -join "`n")" }
        $json = @(($output -join "`n") -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })
        if (-not $json) { throw "no JSON in output`n$($output -join "`n")" }
        return ($json[-1] | ConvertFrom-Json)
    }
    function Test-Issue771Within($Child, $Parent) {
        return ($Child.Extent.StartOffset -ge $Parent.Extent.StartOffset -and
            $Child.Extent.EndOffset -le $Parent.Extent.EndOffset)
    }
    function Test-Issue771NestedScriptBlock($CommandAst, $FunctionAst) {
        $node = $CommandAst.Parent
        while ($node -and $node -ne $FunctionAst.Body) {
            if ($node -is [Management.Automation.Language.ScriptBlockExpressionAst]) { return $true }
            $node = $node.Parent
        }
        return $false
    }
    function Get-Issue771OwningFunction($Node) {
        $current = $Node.Parent
        while ($current) {
            if ($current -is [Management.Automation.Language.FunctionDefinitionAst]) { return $current }
            $current = $current.Parent
        }
        return $null
    }
    function Test-Issue771SameCallerScope($Left, $Right) {
        $leftOwner = Get-Issue771OwningFunction $Left
        $rightOwner = Get-Issue771OwningFunction $Right
        if ($null -eq $leftOwner -or $null -eq $rightOwner) {
            return ($null -eq $leftOwner -and $null -eq $rightOwner)
        }
        return ($leftOwner.Extent.StartOffset -eq $rightOwner.Extent.StartOffset -and
            $leftOwner.Extent.EndOffset -eq $rightOwner.Extent.EndOffset)
    }
    function Resolve-Issue771DotSourceTarget {
        param([string]$Text, [string]$SourcePath, [string]$RepositoryRoot)

        $relative = $null
        $rootExpression = $null
        if ($Text -match '(?is)^\s*\.\s*\(\s*Join-Path\s+\$([A-Za-z_][A-Za-z0-9_:]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s+[''"]([^''"]+\.(?:ps1|psm1))[''"]') {
            $rootExpression = $Matches[1]
            $relative = $Matches[2]
        }
        elseif ($Text -match '(?is)^\s*\.\s+[''"]([^''"]+\.(?:ps1|psm1))[''"]') {
            $relative = $Matches[1]
        }
        if (-not $relative) { return $null }

        $candidates = [Collections.Generic.List[string]]::new()
        if ([IO.Path]::IsPathRooted($relative)) {
            [void]$candidates.Add($relative)
        }
        else {
            if (($relative -replace '\\', '/') -match '^(scripts|tests)/') {
                [void]$candidates.Add((Join-Path $RepositoryRoot $relative))
            }
            if (-not $rootExpression -or $rootExpression -eq 'PSScriptRoot') {
                [void]$candidates.Add((Join-Path (Split-Path -Parent $SourcePath) $relative))
            }
            [void]$candidates.Add((Join-Path $RepositoryRoot $relative))
            [void]$candidates.Add((Join-Path (Join-Path $RepositoryRoot 'scripts/lib') ([IO.Path]::GetFileName($relative))))
        }
        foreach ($candidate in $candidates) {
            try {
                $full = [IO.Path]::GetFullPath($candidate)
                if (Test-Path -LiteralPath $full -PathType Leaf) { return $full }
            }
            catch { }
        }
        return $null
    }
    function Get-Issue771ParsedPowerShellRecords([string]$ScanRoot) {
        $records = @()
        foreach ($file in @(Get-ChildItem -LiteralPath $ScanRoot -Recurse -File |
                Where-Object { $_.Extension -in @('.ps1', '.psm1') })) {
            $tokens = $null
            $errors = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
            if (@($errors).Count) { throw "PowerShell parse failure in $($file.FullName): $($errors[0].Message)" }
            $records += [pscustomobject]@{
                Path = $file.FullName
                Ast = $ast
                Commands = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true))
                Functions = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
            }
        }
        return @($records)
    }
    function Get-Issue771DependencyScopeLeaks {
        param([string]$RepositoryRoot, [string]$ScanRoot)

        $records = @(Get-Issue771ParsedPowerShellRecords $ScanRoot)
        $leaks = @()
        foreach ($source in $records) {
            foreach ($loader in $source.Functions) {
                $localDotSources = @($loader.Body.FindAll({
                            param($n)
                            $n -is [Management.Automation.Language.CommandAst] -and
                                $n.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot
                        }, $true) | Where-Object { -not (Test-Issue771NestedScriptBlock $_ $loader) })
                foreach ($dotSource in $localDotSources) {
                    $target = Resolve-Issue771DotSourceTarget $dotSource.Extent.Text $source.Path $RepositoryRoot
                    if (-not $target) { continue }
                    $targetTokens = $null
                    $targetErrors = $null
                    $targetAst = [Management.Automation.Language.Parser]::ParseFile($target, [ref]$targetTokens, [ref]$targetErrors)
                    if (@($targetErrors).Count) { throw "PowerShell parse failure in ${target}: $($targetErrors[0].Message)" }
                    $importedNames = @($targetAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
                        ForEach-Object { $_.Name } | Sort-Object -Unique)
                    if (-not $importedNames) { continue }

                    foreach ($candidate in $records) {
                        $loaderCalls = @($candidate.Commands | Where-Object {
                                $_.GetCommandName() -eq $loader.Name -and
                                -not ($candidate.Path -eq $source.Path -and (Test-Issue771Within $_ $loader))
                            })
                        foreach ($loaderCall in $loaderCalls) {
                            $consumers = @($candidate.Commands | Where-Object {
                                    $name = $_.GetCommandName()
                                    $name -and $importedNames -contains $name -and
                                    $_.Extent.StartOffset -gt $loaderCall.Extent.EndOffset -and
                                    (Test-Issue771SameCallerScope $_ $loaderCall)
                                })
                            foreach ($consumer in $consumers) {
                                $independentLoad = $false
                                foreach ($candidateDotSource in @($candidate.Commands | Where-Object {
                                            $_.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot -and
                                            $_.Extent.StartOffset -lt $consumer.Extent.StartOffset -and
                                            (Test-Issue771SameCallerScope $_ $consumer)
                                        })) {
                                    $candidateTarget = Resolve-Issue771DotSourceTarget $candidateDotSource.Extent.Text $candidate.Path $RepositoryRoot
                                    if ($candidateTarget -and $candidateTarget -eq $target) {
                                        $independentLoad = $true
                                        break
                                    }
                                }
                                if (-not $independentLoad) {
                                    $leaks += [pscustomobject]@{
                                        LoaderPath = $source.Path
                                        LoaderFunction = $loader.Name
                                        ImportedPath = $target
                                        ConsumerPath = $candidate.Path
                                        ConsumerFunction = $consumer.GetCommandName()
                                        ConsumerLine = $consumer.Extent.StartLineNumber
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return @($leaks | Sort-Object LoaderPath, LoaderFunction, ConsumerPath, ConsumerLine -Unique)
    }
}

Describe 'Issue #771 dependency load scope' {
    It 'keeps worker-status GitHub commands visible after lazy import returns' {
        $result = Invoke-Issue771Pwsh @"
. $(Quote-Issue771 $WorkerStore)
Import-WorkerStatusGithubDependencies
@{
 loaded=[bool]`$script:WorkerStatusGithubDependenciesLoaded
 resolve=[bool](Get-Command Resolve-PackGateRepoRoot -CommandType Function -ErrorAction SilentlyContinue)
 gh=[bool](Get-Command Invoke-GhOpenPrListForNumbers -CommandType Function -ErrorAction SilentlyContinue)
 checks=[bool](Get-Command Get-ReconcileChecksByPr -CommandType Function -ErrorAction SilentlyContinue)
 reviews=[bool](Get-Command Get-EnrichedAoReviewRuns -CommandType Function -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Compress
"@
        $result.loaded | Should -BeTrue
        $result.resolve | Should -BeTrue
        $result.gh | Should -BeTrue
        $result.checks | Should -BeTrue
        $result.reviews | Should -BeTrue
    }

    It 'never latches an incomplete load as success or replays partial top-level effects' {
        $dir = New-Issue771Temp
        try {
            Copy-Item $WorkerStore (Join-Path $dir 'WorkerStatusStore.ps1')
            Set-Content (Join-Path $dir 'MechanicalReconcileNode.ps1') ''
            Set-Content (Join-Path $dir 'Get-WorkerOsLiveness.ps1') ''
            Set-Content (Join-Path $dir 'Autonomous-GateCommon.ps1') '$global:Issue771Loads = [int]$global:Issue771Loads + 1'
            Set-Content (Join-Path $dir 'Gh-PrChecks.ps1') "function Invoke-GhOpenPrList { @() }`nfunction Invoke-GhOpenPrListForNumbers { @() }"
            Set-Content (Join-Path $dir 'Get-ReconcileChecksByPr.ps1') 'function Get-ReconcileChecksByPr { @{} }'
            Set-Content (Join-Path $dir 'Review-PostRunRetry.ps1') 'function Get-EnrichedAoReviewRuns { @() }'
            $result = Invoke-Issue771Pwsh @"
. $(Quote-Issue771 (Join-Path $dir 'WorkerStatusStore.ps1'))
`$first=''; try { Import-WorkerStatusGithubDependencies } catch { `$first=`$_.Exception.Message }
Set-Content $(Quote-Issue771 (Join-Path $dir 'Autonomous-GateCommon.ps1')) "function Resolve-PackGateRepoRoot { 'repo' }"
`$second=''; try { Import-WorkerStatusGithubDependencies } catch { `$second=`$_.Exception.Message }
@{ loaded=[bool]`$script:WorkerStatusGithubDependenciesLoaded; first=`$first; second=`$second; loads=[int]`$global:Issue771Loads } | ConvertTo-Json -Compress
"@
            $result.loaded | Should -BeFalse
            $result.first | Should -Match 'missing required commands: Resolve-PackGateRepoRoot'
            $result.second | Should -Match 'previously failed'
            $result.loads | Should -Be 1
        }
        finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Issue #771 fixture-free worker-status recompute' {
    It 'uses the GitHub boundary, computes a snapshot, and writes a store record' {
        $dir = New-Issue771Temp
        try {
            $store = Join-Path $dir 'worker-status-store.json'
            $result = Invoke-Issue771Pwsh @"
. $(Quote-Issue771 $InvokeAo)
Import-WorkerStatusGithubDependencies
`$global:Issue771BoundaryCalls=0
function global:Resolve-PackGateRepoRoot { $(Quote-Issue771 $RepoRoot) }
function global:Invoke-GhOpenPrList { `$global:Issue771BoundaryCalls++; @([pscustomobject]@{ number=771; state='OPEN'; headRefOid='head771'; headCommittedAt='2026-07-13T00:00:00Z' }) }
function global:Invoke-GhOpenPrListForNumbers { `$global:Issue771BoundaryCalls++; @([pscustomobject]@{ number=771; state='OPEN'; headRefOid='head771'; headCommittedAt='2026-07-13T00:00:00Z' }) }
function global:Get-ReconcileChecksByPr { `$global:Issue771BoundaryCalls++; @{ ciChecksByPr=@{ '771'=@([pscustomobject]@{ name='scope-guard'; status='completed'; conclusion='success' }) }; requiredCheckNamesByPr=@{ '771'=@('scope-guard') }; requiredCheckLookupFailedByPr=@{ '771'=`$false } } }
function global:Get-EnrichedAoReviewRuns { @() }
function Test-WorkerStatusKillSwitchActive { `$false }
function Test-WorkerStatusSiblingReadiness { @{ ok=`$true; workerReportStorePresent=`$true; sessionPrBindingResolverPresent=`$true } }
function Resolve-WorkerReportStoreRepoSlug { 'owner/repo' }
function Get-WorkerOsLivenessMap { @{} }
function Get-WorkerStatusWriterGenerationVector { param([string]`$SessionId,[long]`$RepoTickGeneration,`$GithubSnapshot) @{ writerSessionId=`$SessionId; repoTickGeneration=`$RepoTickGeneration; reportStoreGeneration=1; journalCursor=1; bindingCacheGeneration=1 } }
`$sessions=@([pscustomobject]@{ id='opk-771'; sessionId='opk-771'; name='opk-771'; role='worker'; project='orchestrator-pack'; status='working'; activity='working'; prNumber=771; ownedHeadSha='head771'; reports=@([pscustomobject]@{ accepted=`$true; reportState='ready_for_review'; headSha='head771'; reportedAt='2026-07-13T00:00:10Z'; prNumber=771 }) })
`$diag=Invoke-WorkerStatusRefresh -Sessions `$sessions -StorePath $(Quote-Issue771 $store) -NowMs 1783900810000 -RepoTickGeneration 1783900810000 -Owner 'issue-771-test'
`$saved=Get-Content $(Quote-Issue771 $store) -Raw | ConvertFrom-Json
@{ calls=[int]`$global:Issue771BoundaryCalls; degraded=[bool]`$diag.githubDegraded; record=[bool](`$saved.records.PSObject.Properties.Name -contains 'opk-771'); status=[string]`$saved.records.'opk-771'.derivedStatus } | ConvertTo-Json -Compress
"@
            $result.calls | Should -BeGreaterThan 0
            $result.degraded | Should -BeFalse
            $result.record | Should -BeTrue
            $result.status | Should -Be 'ready_for_review'
        }
        finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Issue #771 durable dependency-scope guard' {
    It 'finds no loader-to-consumer scope leaks in production PowerShell' {
        $leaks = @(Get-Issue771DependencyScopeLeaks -RepositoryRoot $RepoRoot -ScanRoot (Join-Path $RepoRoot 'scripts'))
        $leaks | Should -BeNullOrEmpty -Because ($leaks | ConvertTo-Json -Compress -Depth 8)
    }

    It 'fails for an unrelated synthetic cross-file loader and consumer' {
        $dir = New-Issue771Temp
        try {
            Set-Content (Join-Path $dir 'Dependency.ps1') "function Invoke-SyntheticDependency { 'ok' }"
            Set-Content (Join-Path $dir 'Loader.ps1') "function Initialize-UnrelatedDependency { . (Join-Path `$PSScriptRoot 'Dependency.ps1') }"
            Set-Content (Join-Path $dir 'Consumer.ps1') ". (Join-Path `$PSScriptRoot 'Loader.ps1')`nfunction Invoke-UnrelatedConsumer { Initialize-UnrelatedDependency; Invoke-SyntheticDependency }`nInvoke-UnrelatedConsumer"
            $leaks = @(Get-Issue771DependencyScopeLeaks -RepositoryRoot $dir -ScanRoot $dir)
            $leaks.Count | Should -Be 1
            $leaks[0].LoaderFunction | Should -Be 'Initialize-UnrelatedDependency'
            $leaks[0].ConsumerFunction | Should -Be 'Invoke-SyntheticDependency'
        }
        finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
