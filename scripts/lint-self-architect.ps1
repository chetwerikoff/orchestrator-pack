[CmdletBinding()]
param(
    [switch]$Strict,
    [string]$BaseRef,
    [string]$HeadRef = 'HEAD',
    [string]$ConfigPath,
    [string]$RepoRoot,
    [switch]$WithWorkingTree,
    [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'

function Get-DefaultConfig {
    return [ordered]@{
        scanPaths               = @('prompts/**', 'scripts/**', 'plugins/**', 'docs/**', '.github/**')
        excludePaths            = @('tests/fixtures/**', 'vendor/**', 'packages/core/**', '.ao/**', 'node_modules/**')
        scriptExtensions        = @('.ps1', '.sh', '.bash', '.js', '.ts', '.mjs', '.cjs')
        templateExtensions      = @('.md', '.yaml', '.yml', '.json', '.example', '.template', '.tpl')
        duplicateLiteralMinLines = 10
        pairedEditMinLines      = 8
        pairedLineStride        = 2
        heuristicMinLines       = 3
        heuristicMaxLines       = 9
        similarityThreshold     = 0.85
        heuristicLineStride     = 3
        heuristicMaxFindings    = 25
        heuristicMaxFileLines   = 300
        pairedOverlapMinLines   = 6
        pairedOverlapMinRatio   = 0.75
        suppressions            = @()
    }
}

function Read-LintConfig {
    param([string]$Path)

    $defaults = Get-DefaultConfig
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $defaults
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $json = $raw | ConvertFrom-Json
    $config = Get-DefaultConfig
    foreach ($key in @($config.Keys)) {
        if ($null -ne $json.$key) {
            $config[$key] = $json.$key
        }
    }
    return $config
}

function Normalize-RepoPath {
    param([string]$Path)
    return ($Path -replace '\\', '/').TrimStart('./')
}

function Test-PathMatchesAnyPattern {
    param(
        [string]$RelativePath,
        [string[]]$Patterns
    )

    $normalized = Normalize-RepoPath $RelativePath
    foreach ($pattern in $Patterns) {
        $glob = Normalize-RepoPath $pattern
        if ($glob -match '[\*\?\[\]]') {
            if ($normalized -like ($glob -replace '/', '\')) {
                return $true
            }
            $regex = '^' + ($glob -replace '\.', '\.' -replace '\*\*', '<<DOUBLESTAR>>' -replace '\*', '[^/]*' -replace '<<DOUBLESTAR>>', '.*' -replace '\?', '.') + '$'
            if ($normalized -match $regex) {
                return $true
            }
        }
        elseif ($normalized -eq $glob -or $normalized.StartsWith("$glob/")) {
            return $true
        }
    }
    return $false
}

function Test-ShouldScanPath {
    param(
        [string]$RelativePath,
        [hashtable]$Config
    )

    if (Test-PathMatchesAnyPattern -RelativePath $RelativePath -Patterns $Config.excludePaths) {
        return $false
    }
    if ($Config.scanPaths.Count -eq 0) {
        return $true
    }
    return (Test-PathMatchesAnyPattern -RelativePath $RelativePath -Patterns $Config.scanPaths)
}

function Get-RepoRoot {
    param([string]$Start)

    if ($Start) {
        return (Resolve-Path -LiteralPath $Start).Path
    }

    $scriptRoot = Split-Path -Parent $PSScriptRoot
    return (Resolve-Path -LiteralPath $scriptRoot).Path
}

function Invoke-GitQuiet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$GitArgs
    )

    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $nativePreference = $null
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
        $nativePreference = $PSNativeCommandUseErrorActionPreference
        $PSNativeCommandUseErrorActionPreference = $false
    }

    try {
        $output = & git @GitArgs 2>&1
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output   = @($output)
        }
    }
    finally {
        $ErrorActionPreference = $prevErrorAction
        if ($null -ne $nativePreference) {
            $PSNativeCommandUseErrorActionPreference = $nativePreference
        }
    }
}

function Get-ChangedRelativePaths {
    param(
        [string]$Root,
        [string]$BaseRef,
        [string]$HeadRef = 'HEAD',
        [switch]$IncludeWorkingTree
    )

    Push-Location $Root
    try {
        $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

        if ($BaseRef) {
            $diffArgs = @('diff', '--name-only', "$BaseRef...$HeadRef")
            $names = @(& git @diffArgs 2>$null)
            if ($LASTEXITCODE -ne 0) {
                $names = @(& git diff --name-only $BaseRef $HeadRef 2>$null)
            }
            foreach ($name in $names) {
                if ($name) { [void]$paths.Add((Normalize-RepoPath $name)) }
            }
            return @($paths)
        }

        $staged = @(& git diff --cached --name-only 2>$null)
        foreach ($name in $staged) {
            if ($name) { [void]$paths.Add((Normalize-RepoPath $name)) }
        }

        if ($IncludeWorkingTree) {
            $unstaged = @(& git diff --name-only 2>$null)
            foreach ($name in $unstaged) {
                if ($name) { [void]$paths.Add((Normalize-RepoPath $name)) }
            }

            $untracked = @(& git ls-files --others --exclude-standard 2>$null)
            foreach ($name in $untracked) {
                if ($name) { [void]$paths.Add((Normalize-RepoPath $name)) }
            }
        }

        return @($paths)
    }
    finally {
        Pop-Location
    }
}

function Get-ScanTargetRelativePaths {
    param(
        [string]$Root,
        [hashtable]$Config
    )

    Push-Location $Root
    try {
        $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        $tracked = @(& git ls-files 2>$null)
        if ($LASTEXITCODE -ne 0) {
            return @()
        }

        foreach ($name in $tracked) {
            if (-not $name) { continue }
            $normalized = Normalize-RepoPath $name
            if (Test-ShouldScanPath -RelativePath $normalized -Config $Config) {
                [void]$paths.Add($normalized)
            }
        }

        return @($paths)
    }
    finally {
        Pop-Location
    }
}

function Get-FixtureRelativePaths {
    param([string]$FixtureDirectory)

    $root = (Resolve-Path -LiteralPath $FixtureDirectory).Path
    $files = Get-ChildItem -LiteralPath $root -Recurse -File
    return @(
        $files |
            ForEach-Object {
                $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/')
                Normalize-RepoPath $relative
            }
    )
}

function Read-TextLines {
    param([string]$FullPath)

    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        return @()
    }

    $content = Get-Content -LiteralPath $FullPath -Encoding UTF8
    return @($content | ForEach-Object { $_.TrimEnd() })
}

function Get-FileKind {
    param(
        [string]$RelativePath,
        [hashtable]$Config
    )

    $extension = [System.IO.Path]::GetExtension($RelativePath).ToLowerInvariant()
    if ($Config.scriptExtensions -contains $extension) { return 'script' }
    if ($Config.templateExtensions -contains $extension) { return 'template' }
    return 'other'
}

function New-Finding {
    param(
        [string]$Rule,
        [string]$Severity,
        [string]$Rationale,
        [object[]]$Locations
    )

    return [pscustomobject]@{
        rule       = $Rule
        severity   = $Severity
        rationale  = $Rationale
        locations  = $Locations
    }
}

function Format-Location {
    param(
        [string]$File,
        [int]$StartLine,
        [int]$EndLine
    )

    return [pscustomobject]@{
        file      = $File
        startLine = $StartLine
        endLine   = $EndLine
    }
}

function Test-Suppressed {
    param(
        [hashtable]$Config,
        [string]$Rule,
        [string[]]$Files
    )

    foreach ($entry in $Config.suppressions) {
        if ($entry.rule -and $entry.rule -ne $Rule) { continue }
        $entryFiles = @($entry.files | ForEach-Object { Normalize-RepoPath $_ })
        if ($entryFiles.Count -eq 0) { continue }
        $allMatch = $true
        foreach ($file in $Files) {
            if ($entryFiles -notcontains (Normalize-RepoPath $file)) {
                $allMatch = $false
                break
            }
        }
        if ($allMatch) { return $true }
    }
    return $false
}

function Test-MeaningfulBlock {
    param([string[]]$Lines)

    return (($Lines | Where-Object { $_ -match '\S' }).Count -gt 0)
}

function Get-SlidingBlocks {
    param(
        [string[]]$Lines,
        [int]$Size
    )

    $blocks = @()
    if ($Lines.Count -lt $Size) { return $blocks }

    for ($start = 0; $start -le ($Lines.Count - $Size); $start++) {
        $slice = @($Lines[$start..($start + $Size - 1)])
        if (-not (Test-MeaningfulBlock -Lines $slice)) { continue }
        $blocks += [pscustomobject]@{
            text      = ($slice -join "`n")
            startLine = $start + 1
            endLine   = $start + $Size
            lineCount = $Size
        }
    }
    return $blocks
}

function Get-RenameMap {
    param(
        [string]$Root,
        [string]$BaseRef,
        [string]$HeadRef
    )

    $map = @{}
    Push-Location $Root
    try {
        $result = Invoke-GitQuiet -GitArgs @('diff', '--name-status', '-M', "${BaseRef}...${HeadRef}")
        if ($result.ExitCode -ne 0) {
            $result = Invoke-GitQuiet -GitArgs @('diff', '--name-status', '-M', $BaseRef, $HeadRef)
        }

        foreach ($line in $result.Output) {
            if ($line -isnot [string]) { continue }
            $parts = $line -split "`t"
            if ($parts.Count -lt 3) { continue }
            if ($parts[0] -notmatch '^R\d+$') { continue }

            $oldPath = Normalize-RepoPath $parts[1]
            $newPath = Normalize-RepoPath $parts[2]
            $map[$newPath.ToLowerInvariant()] = $oldPath
        }

        return $map
    }
    finally {
        Pop-Location
    }
}

function Get-BaseFileLines {
    param(
        [string]$Root,
        [string]$BaseRef,
        [string]$RelativePath
    )

    Push-Location $Root
    try {
        $spec = "${BaseRef}:${RelativePath}"
        $result = Invoke-GitQuiet -GitArgs @('show', $spec)
        if ($result.ExitCode -ne 0) {
            return @()
        }

        return @(
            $result.Output |
                Where-Object { $_ -is [string] } |
                ForEach-Object { $_.TrimEnd() }
        )
    }
    finally {
        Pop-Location
    }
}

function Test-BlockExistsInLines {
    param(
        [string[]]$Lines,
        [string]$BlockText,
        [int]$Size
    )

    if ($Lines.Count -lt $Size) { return $false }

    for ($start = 0; $start -le ($Lines.Count - $Size); $start++) {
        $candidate = ($Lines[$start..($start + $Size - 1)] -join "`n")
        if ($candidate -eq $BlockText) {
            return $true
        }
    }

    return $false
}

function Test-IsBlockNovelAtPath {
    param(
        [string]$Root,
        [string]$BaseRef,
        [string]$RelativePath,
        [string]$BlockText,
        [int]$Size,
        [hashtable]$BaseLinesCache,
        [hashtable]$RenameMap
    )

    $normalized = Normalize-RepoPath $RelativePath
    $lookupKey = $normalized.ToLowerInvariant()
    if (-not $BaseLinesCache.ContainsKey($normalized)) {
        $baseLinesCache[$normalized] = Get-BaseFileLines -Root $Root -BaseRef $BaseRef -RelativePath $normalized
    }

    $baseLines = $baseLinesCache[$normalized]
    if ($baseLines.Count -eq 0 -and $RenameMap -and $RenameMap.ContainsKey($lookupKey)) {
        $renamedFrom = $RenameMap[$lookupKey]
        if (-not $BaseLinesCache.ContainsKey($renamedFrom)) {
            $baseLinesCache[$renamedFrom] = Get-BaseFileLines -Root $Root -BaseRef $BaseRef -RelativePath $renamedFrom
        }
        $baseLines = $baseLinesCache[$renamedFrom]
    }

    if ($baseLines.Count -eq 0) {
        return $true
    }

    return -not (Test-BlockExistsInLines -Lines $baseLines -BlockText $BlockText -Size $Size)
}

function Get-LineSimilarity {
    param(
        [string[]]$Left,
        [string[]]$Right
    )

    if ($Left.Count -eq 0 -or $Right.Count -eq 0) { return 0.0 }
    $matchCount = 0
    $limit = [Math]::Min($Left.Count, $Right.Count)
    for ($i = 0; $i -lt $limit; $i++) {
        if ($Left[$i] -eq $Right[$i]) { $matchCount++ }
    }
    return [double]$matchCount / [Math]::Max($Left.Count, $Right.Count)
}

function Find-DuplicateLiteralFindings {
    param(
        [hashtable]$FileLines,
        [hashtable]$Config,
        [string[]]$IntroducedInPaths = @(),
        [string]$Root,
        [string]$BaseRef,
        [string]$HeadRef
    )

    $findings = New-Object System.Collections.Generic.List[object]
    $minStrict = [int]$Config.duplicateLiteralMinLines
    $renameMap = @{}
    if ($BaseRef -and $HeadRef) {
        $renameMap = Get-RenameMap -Root $Root -BaseRef $BaseRef -HeadRef $HeadRef
    }
    $blockMap = New-Object 'System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[object]]'
    $introduced = @{}
    foreach ($path in $IntroducedInPaths) {
        if ($path) {
            $introduced[(Normalize-RepoPath $path).ToLowerInvariant()] = $true
        }
    }
    $requireIntroduced = ($introduced.Count -gt 0)

    foreach ($entry in $FileLines.GetEnumerator()) {
        $relativePath = $entry.Key
        $blocks = Get-SlidingBlocks -Lines $entry.Value -Size $minStrict
        foreach ($block in $blocks) {
            $blockKey = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($block.text))
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

    foreach ($pair in $blockMap.GetEnumerator()) {
        $locations = @($pair.Value | Sort-Object file, startLine)
        $distinctFiles = @($locations | Select-Object -ExpandProperty file -Unique)
        if ($distinctFiles.Count -lt 2) { continue }

        if ($requireIntroduced) {
            $touchesIntroduced = $false
            $touchesUnchanged = $false
            foreach ($file in $distinctFiles) {
                $normalizedFile = (Normalize-RepoPath $file).ToLowerInvariant()
                if ($introduced.ContainsKey($normalizedFile)) {
                    $touchesIntroduced = $true
                }
                else {
                    $touchesUnchanged = $true
                }
            }

            if (-not $touchesIntroduced) { continue }

            if ($BaseRef) {
                $sampleLoc = $locations[0]
                $samplePath = Normalize-RepoPath $sampleLoc.file
                $blockText = (
                    $FileLines[$samplePath][($sampleLoc.startLine - 1)..($sampleLoc.endLine - 1)] -join "`n"
                )
                $baseLinesCache = @{}
                $shouldReport = $false

                if ($touchesUnchanged) {
                    foreach ($loc in $locations) {
                        $changedPath = Normalize-RepoPath $loc.file
                        if (-not $introduced.ContainsKey($changedPath.ToLowerInvariant())) { continue }

                        if (Test-IsBlockNovelAtPath -Root $Root -BaseRef $BaseRef -RelativePath $changedPath -BlockText $blockText -Size $sampleLoc.lineCount -BaseLinesCache $baseLinesCache -RenameMap $renameMap) {
                            $shouldReport = $true
                            break
                        }
                    }
                }
                else {
                    $novelIntroducedCount = 0
                    foreach ($file in $distinctFiles) {
                        $introducedPath = Normalize-RepoPath $file
                        if (-not $introduced.ContainsKey($introducedPath.ToLowerInvariant())) { continue }

                        if (Test-IsBlockNovelAtPath -Root $Root -BaseRef $BaseRef -RelativePath $introducedPath -BlockText $blockText -Size $sampleLoc.lineCount -BaseLinesCache $baseLinesCache -RenameMap $renameMap) {
                            $novelIntroducedCount++
                        }
                    }

                    # One novel introduced path is enough: the other file may already
                    # contain the block at base but still be in IntroducedInPaths.
                    if ($novelIntroducedCount -ge 1) {
                        $shouldReport = $true
                    }
                }

                if (-not $shouldReport) { continue }
            }
        }

        $lineCount = $locations[0].lineCount
        $rule = 'duplicate-literal'
        $files = @($distinctFiles)
        if (Test-Suppressed -Config $Config -Rule $rule -Files $files) { continue }

        $severity = if ($lineCount -ge $minStrict) { 'strict' } else { 'warning' }
        $rationale = "Exact duplicate prompt literal ($lineCount lines) across $($distinctFiles.Count) files; centralize into one source of truth."
        $findingLocations = @(
            $locations |
                ForEach-Object { Format-Location -File $_.file -StartLine $_.startLine -EndLine $_.endLine }
        )
        $findings.Add((New-Finding -Rule $rule -Severity $severity -Rationale $rationale -Locations $findingLocations)) | Out-Null
    }

    if ($findings.Count -eq 0) { return @() }
    return $findings.ToArray()
}

function Find-HeuristicDuplicateFindings {
    param(
        [hashtable]$FileLines,
        [hashtable]$Config
    )

    $findings = New-Object System.Collections.Generic.List[object]
    $minLines = [int]$Config.heuristicMinLines
    $maxLines = [int]$Config.heuristicMaxLines
    $threshold = [double]$Config.similarityThreshold
    $stride = [int]$Config.heuristicLineStride
    if ($stride -lt 1) { $stride = 1 }
    $maxFindings = [int]$Config.heuristicMaxFindings
    if ($maxFindings -lt 1) { $maxFindings = 1 }
    $maxFileLines = [int]$Config.heuristicMaxFileLines
    $paths = @($FileLines.Keys)

    for ($i = 0; $i -lt $paths.Count; $i++) {
        if ($findings.Count -ge $maxFindings) { break }
        for ($j = $i + 1; $j -lt $paths.Count; $j++) {
            if ($findings.Count -ge $maxFindings) { break }

            $leftPath = $paths[$i]
            $rightPath = $paths[$j]
            $leftLines = $FileLines[$leftPath]
            $rightLines = $FileLines[$rightPath]

            if ($maxFileLines -gt 0) {
                if ($leftLines.Count -gt $maxFileLines -or $rightLines.Count -gt $maxFileLines) {
                    continue
                }
            }

            for ($size = $minLines; $size -le $maxLines; $size++) {
                if ($findings.Count -ge $maxFindings) { break }
                if ($leftLines.Count -lt $size -or $rightLines.Count -lt $size) { continue }

                for ($li = 0; $li -le ($leftLines.Count - $size); $li += $stride) {
                    if ($findings.Count -ge $maxFindings) { break }

                    for ($ri = 0; $ri -le ($rightLines.Count - $size); $ri += $stride) {
                        if ($findings.Count -ge $maxFindings) { break }

                        $similarity = Get-LineSimilarity -Left @($leftLines[$li..($li + $size - 1)]) -Right @($rightLines[$ri..($ri + $size - 1)])
                        if ($similarity -ge $threshold -and $similarity -lt 1.0) {
                            $rule = 'near-duplicate-literal'
                            if (Test-Suppressed -Config $Config -Rule $rule -Files @($leftPath, $rightPath)) { continue }
                            $findings.Add((New-Finding -Rule $rule -Severity 'warning' -Rationale "Near-duplicate literal block (~$([int]($similarity * 100))% line match, $size lines); consider extracting a shared source." -Locations @(
                                    (Format-Location -File $leftPath -StartLine ($li + 1) -EndLine ($li + $size)),
                                    (Format-Location -File $rightPath -StartLine ($ri + 1) -EndLine ($ri + $size))
                                ))) | Out-Null
                        }
                    }
                }
            }
        }
    }

    if ($findings.Count -eq 0) { return @() }
    return $findings.ToArray()
}

function Find-PairedEditFindings {
    param(
        [hashtable]$FileLines,
        [string[]]$ChangedPaths,
        [hashtable]$Config
    )

    $findings = New-Object System.Collections.Generic.List[object]
    $minLines = [int]$Config.pairedEditMinLines
    $overlapMin = [int]$Config.pairedOverlapMinLines
    $overlapRatioMin = [double]$Config.pairedOverlapMinRatio
    $stride = [int]$Config.pairedLineStride
    if ($stride -lt 1) { $stride = 1 }
    $size = $minLines
    $changed = @{}
    foreach ($path in $ChangedPaths) {
        $normalized = Normalize-RepoPath $path
        $changed[$normalized.ToLowerInvariant()] = $true
    }

    $scripts = @($FileLines.Keys | Where-Object { (Get-FileKind -RelativePath $_ -Config $Config) -eq 'script' })
    $templates = @($FileLines.Keys | Where-Object { (Get-FileKind -RelativePath $_ -Config $Config) -eq 'template' })

    foreach ($scriptPath in $scripts) {
        if (-not $changed.ContainsKey($scriptPath.ToLowerInvariant())) { continue }
        foreach ($templatePath in $templates) {
            if (-not $changed.ContainsKey($templatePath.ToLowerInvariant())) { continue }

            $scriptLines = $FileLines[$scriptPath]
            $templateLines = $FileLines[$templatePath]
            if ($scriptLines.Count -lt $minLines -or $templateLines.Count -lt $minLines) { continue }

            $bestMatch = $null
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

            if ($bestMatch) {
                $rule = 'paired-edit-divergence'
                if (Test-Suppressed -Config $Config -Rule $rule -Files @($scriptPath, $templatePath)) { continue }

                $pct = [int]($bestMatch.overlapRatio * 100)
                $findings.Add((New-Finding -Rule $rule -Severity 'strict' -Rationale "Paired script/template edit: shared $($bestMatch.size)-line block diverged ($($bestMatch.matching)/$($bestMatch.size) lines, $pct% overlap); extract or generate from one source." -Locations @(
                        (Format-Location -File $scriptPath -StartLine ($bestMatch.si + 1) -EndLine ($bestMatch.si + $bestMatch.size)),
                        (Format-Location -File $templatePath -StartLine ($bestMatch.ti + 1) -EndLine ($bestMatch.ti + $bestMatch.size))
                    ))) | Out-Null
            }
        }
    }

    if ($findings.Count -eq 0) { return @() }
    return $findings.ToArray()
}

function Write-FindingLine {
    param([object]$Finding)

    $locationText = (
        $Finding.locations |
            ForEach-Object { '{0}:{1}-{2}' -f $_.file, $_.startLine, $_.endLine }
    ) -join ', '
    $tag = if ($Finding.severity -eq 'strict') { 'STRICT' } else { 'WARN' }
    Write-Output ("[{0}] {1}: {2} - {3}" -f $tag, $Finding.rule, $locationText, $Finding.rationale)
}

# --- main ---
$Root = Get-RepoRoot -Start $RepoRoot
$configFile = if ($ConfigPath) { $ConfigPath } else { Join-Path $PSScriptRoot 'lint-self-architect.config.json' }
$Config = Read-LintConfig -Path $configFile

$changedPaths = @()
if ($FixtureRoot) {
    $fixturePath = if ([System.IO.Path]::IsPathRooted($FixtureRoot)) { $FixtureRoot } else { Join-Path $Root $FixtureRoot }
    $changedPaths = Get-FixtureRelativePaths -FixtureDirectory $fixturePath
    $Root = (Resolve-Path -LiteralPath $fixturePath).Path
}
else {
    $changedParams = @{
        Root    = $Root
        HeadRef = $HeadRef
    }
    if ($BaseRef) {
        $changedParams['BaseRef'] = $BaseRef
    }
    if ($WithWorkingTree) {
        $changedParams['IncludeWorkingTree'] = $true
    }
    $changedPaths = Get-ChangedRelativePaths @changedParams
}

$scanPaths = @(
    $changedPaths | Where-Object { Test-ShouldScanPath -RelativePath $_ -Config $Config }
)

if ($FixtureRoot) {
    $comparisonPaths = $scanPaths
}
else {
    $comparisonPathSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in @(Get-ScanTargetRelativePaths -Root $Root -Config $Config)) {
        if ($path) { [void]$comparisonPathSet.Add((Normalize-RepoPath $path)) }
    }
    foreach ($path in $scanPaths) {
        if ($path) { [void]$comparisonPathSet.Add((Normalize-RepoPath $path)) }
    }
    $comparisonPaths = @($comparisonPathSet)
}

$fileLines = @{}
foreach ($relative in $comparisonPaths) {
    $fullPath = Join-Path $Root ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    $fileLines[$relative] = Read-TextLines -FullPath $fullPath
}

$heuristicFileLines = @{}
foreach ($relative in $scanPaths) {
    if ($fileLines.ContainsKey($relative)) {
        $heuristicFileLines[$relative] = $fileLines[$relative]
    }
}

$allFindings = New-Object System.Collections.Generic.List[object]
foreach ($finding in (Find-DuplicateLiteralFindings -FileLines $fileLines -Config $Config -IntroducedInPaths $scanPaths -Root $Root -BaseRef $BaseRef -HeadRef $HeadRef)) {
    $allFindings.Add($finding) | Out-Null
}
foreach ($finding in (Find-PairedEditFindings -FileLines $fileLines -ChangedPaths $changedPaths -Config $Config)) {
    $allFindings.Add($finding) | Out-Null
}
$heuristicSkipped = $false
if ($Strict) {
    $heuristicSkipped = $true
}
else {
    foreach ($finding in (Find-HeuristicDuplicateFindings -FileLines $heuristicFileLines -Config $Config)) {
        $allFindings.Add($finding) | Out-Null
    }
}

$strictFindings = @($allFindings | Where-Object { $_.severity -eq 'strict' })
$warningFindings = @($allFindings | Where-Object { $_.severity -eq 'warning' })

Write-Host '== self-architect lint =='
Write-Host "Root: $Root"
if ($BaseRef) {
    Write-Host "Diff: $BaseRef...$HeadRef"
}
elseif ($FixtureRoot) {
    Write-Host "Fixture: $FixtureRoot"
}
else {
    $scopeLabel = 'Scope: staged changes'
    if ($WithWorkingTree) { $scopeLabel += ' + unstaged/untracked' }
    Write-Host $scopeLabel
}
Write-Host "Changed files: $($scanPaths.Count)"
Write-Host "Comparison files: $($comparisonPaths.Count)"
if ($heuristicSkipped) {
    Write-Host 'Heuristic near-duplicate scan: skipped (-Strict / CI mode)'
}
Write-Host ''

if ($allFindings.Count -eq 0) {
    Write-Host 'No findings.'
}
else {
    foreach ($finding in $allFindings) {
        Write-FindingLine $finding
    }
}

Write-Host ''
Write-Host ('Summary: strict={0} warning={1}' -f $strictFindings.Count, $warningFindings.Count)

if ($Strict -and $strictFindings.Count -gt 0) {
    exit 1
}

exit 0
