# Shared skill-pointer generation (Issue #156). Dot-source from generate/check scripts.

function Initialize-SkillPointerScript {
    param([string]$ScriptLeafName)

    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Write-Host "[FAIL] scripts/$ScriptLeafName requires PowerShell 7+ (pwsh)."
        exit 1
    }
}

function Resolve-SkillPointerRepoRoot {
    param([string]$RepoRoot)

    if ($RepoRoot) {
        return $RepoRoot
    }
    return Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Get-SkillPointerConfig {
    param(
        [string]$Root,
        [string]$ConfigPath = ''
    )

    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $Root 'scripts/skill-pointer-targets.json'
    }
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Skill pointer config not found: $ConfigPath"
    }

    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
    $config = $raw | ConvertFrom-Json
    if (-not $config.canonicalRoot) {
        throw 'skill-pointer-targets.json must define canonicalRoot'
    }
    if (-not $config.targets -or $config.targets.Count -lt 1) {
        throw 'skill-pointer-targets.json must define at least one target'
    }
    return $config
}

function Get-CanonicalSkillNames {
    param(
        [string]$Root,
        [string]$CanonicalRoot
    )

    $skillsDir = Join-Path $Root $CanonicalRoot
    if (-not (Test-Path -LiteralPath $skillsDir -PathType Container)) {
        throw "Canonical skills root not found: $CanonicalRoot"
    }

    $names = @(
        Get-ChildItem -LiteralPath $skillsDir -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf
            } |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    return $names
}

function Split-SkillFrontmatter {
    param([string]$Content)

    if ($Content -notmatch '(?s)\A---\r?\n(.*?)\r?\n---\r?\n') {
        throw 'SKILL.md missing YAML frontmatter delimiters (---)'
    }

    return @{
        Frontmatter = $Matches[1]
        Body        = $Content.Substring($Matches[0].Length)
    }
}

function Get-SkillFrontmatterFields {
    param([string]$Frontmatter)

    $name = $null
    $descriptionLines = New-Object System.Collections.Generic.List[string]
    $inDescription = $false
    $descriptionFolded = $false

    foreach ($line in ($Frontmatter -split "`r?`n")) {
        if (-not $inDescription) {
            if ($line -match '^\s*name:\s*(.+)\s*$') {
                $name = $Matches[1].Trim().Trim('"').Trim("'")
                continue
            }
            if ($line -match '^\s*description:\s*(.*)\s*$') {
                $rest = $Matches[1]
                if ($rest -match '^>-?\s*$') {
                    $descriptionFolded = $true
                    $inDescription = $true
                }
                elseif ($rest.Length -gt 0) {
                    $descriptionLines.Add($rest) | Out-Null
                    $inDescription = $false
                }
                else {
                    $inDescription = $true
                }
                continue
            }
            continue
        }

        if ($line -match '^\s{2,}(.+)$') {
            $descriptionLines.Add($Matches[1].TrimEnd()) | Out-Null
        }
        else {
            break
        }
    }

    if (-not $name) {
        throw 'SKILL frontmatter missing required name:'
    }
    if ($descriptionLines.Count -eq 0) {
        throw "SKILL frontmatter for '$name' missing required description"
    }

    $description = if ($descriptionFolded) {
        ($descriptionLines -join ' ').Trim()
    }
    else {
        ($descriptionLines -join "`n").Trim()
    }

    return @{
        Name              = $name
        Description       = $description
        DescriptionFolded = $descriptionFolded
    }
}

function Format-FoldedDescriptionYaml {
    param([string]$Description)

    $words = $Description -split '\s+'
    $lines = New-Object System.Collections.Generic.List[string]
    $current = ''

    foreach ($word in $words) {
        if (-not $word) { continue }
        $candidate = if ($current) { "$current $word" } else { $word }
        if ($candidate.Length -le 78) {
            $current = $candidate
        }
        else {
            if ($current) { $lines.Add($current) | Out-Null }
            $current = $word
        }
    }
    if ($current) { $lines.Add($current) | Out-Null }
    if ($lines.Count -eq 0) { $lines.Add('') | Out-Null }

    $out = New-Object System.Collections.Generic.List[string]
    $out.Add('description: >-') | Out-Null
    foreach ($line in $lines) {
        $out.Add("  $line") | Out-Null
    }
    return ($out -join "`n")
}

function Format-SkillPointerFrontmatter {
    param(
        [string]$Name,
        [string]$Description,
        [bool]$DescriptionFolded
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('---') | Out-Null
    $lines.Add("name: $Name") | Out-Null

    if ($DescriptionFolded) {
        $lines.Add((Format-FoldedDescriptionYaml -Description $Description)) | Out-Null
    }
    else {
        $lines.Add("description: $Description") | Out-Null
    }

    $lines.Add('---') | Out-Null
    return ($lines -join "`n")
}

function New-SkillPointerContent {
    param(
        [string]$SkillName,
        [string]$Name,
        [string]$Description,
        [bool]$DescriptionFolded,
        [string]$CanonicalLinkPrefix
    )

    $canonicalRel = "$CanonicalLinkPrefix/$SkillName/SKILL.md"
    $frontmatter = Format-SkillPointerFrontmatter -Name $Name -Description $Description -DescriptionFolded $DescriptionFolded
    $linkLabel = ".claude/skills/$SkillName/SKILL.md"
    $body = ('Read and execute [`{0}`]({1}) in full. Do not re-derive the workflow inline.' -f $linkLabel, $canonicalRel)

    return "$frontmatter`n`n$body`n"
}

function Get-ExpectedSkillPointerMap {
    param(
        [string]$Root,
        [object]$Config
    )

    $map = @{}
    $canonicalRoot = $Config.canonicalRoot
    $skillNames = Get-CanonicalSkillNames -Root $Root -CanonicalRoot $canonicalRoot

    foreach ($skillName in $skillNames) {
        $canonicalPath = Join-Path $Root (Join-Path $canonicalRoot "$skillName/SKILL.md")
        $raw = Get-Content -LiteralPath $canonicalPath -Raw -Encoding UTF8
        $parts = Split-SkillFrontmatter -Content $raw
        $fields = Get-SkillFrontmatterFields -Frontmatter $parts.Frontmatter

        foreach ($target in $Config.targets) {
            $pointerRel = Join-Path $target.root "$skillName/SKILL.md"
            $content = New-SkillPointerContent `
                -SkillName $skillName `
                -Name $fields.Name `
                -Description $fields.Description `
                -DescriptionFolded $fields.DescriptionFolded `
                -CanonicalLinkPrefix $target.canonicalLinkPrefix

            $map[$pointerRel] = $content
        }
    }

    return $map
}

function Write-SkillPointers {
    param(
        [string]$Root,
        [hashtable]$ExpectedMap
    )

    foreach ($entry in $ExpectedMap.GetEnumerator()) {
        $rel = $entry.Key
        $content = $entry.Value
        $fullPath = Join-Path $Root $rel
        $dir = Split-Path -Parent $fullPath
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        [System.IO.File]::WriteAllText($fullPath, $content, [System.Text.UTF8Encoding]::new($false))
    }
}

function Test-SkillPointerDrift {
    param(
        [string]$Root,
        [object]$Config
    )

    $failures = New-Object System.Collections.Generic.List[string]
    $expected = Get-ExpectedSkillPointerMap -Root $Root -Config $Config

    foreach ($entry in $expected.GetEnumerator()) {
        $rel = $entry.Key -replace '\\', '/'
        $expectedContent = $entry.Value
        $fullPath = Join-Path $Root $rel

        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            $failures.Add("Missing pointer: $rel (run scripts/generate-skill-pointers.ps1)") | Out-Null
            continue
        }

        $actual = [System.IO.File]::ReadAllText($fullPath, [System.Text.UTF8Encoding]::new($false))
        if ($actual -ne $expectedContent) {
            $failures.Add("Pointer drift: $rel (run scripts/generate-skill-pointers.ps1)") | Out-Null
        }
    }

    $canonicalRoot = $Config.canonicalRoot
    foreach ($target in $Config.targets) {
        $targetRoot = Join-Path $Root $target.root
        if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
            continue
        }
        $extra = @(
            Get-ChildItem -LiteralPath $targetRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object {
                    Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf
                } |
                ForEach-Object { $_.Name }
        )
        $canonicalNames = Get-CanonicalSkillNames -Root $Root -CanonicalRoot $canonicalRoot
        foreach ($name in $extra) {
            if ($canonicalNames -notcontains $name) {
                $rel = Join-Path $target.root "$name/SKILL.md" -replace '\\', '/'
                $failures.Add("Orphan pointer without canonical skill: $rel") | Out-Null
            }
        }
    }

    return $failures
}
