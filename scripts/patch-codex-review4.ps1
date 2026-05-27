# Temporary compatibility patch for AO 0.9.2 Windows Codex review bugs.
# See README.md ("AO 0.9.2 Windows Codex review patch") for retirement conditions.

$ErrorActionPreference = 'Stop'

$FixedAoVersion = [version]'0.9.3'
$MinAffectedVersion = [version]'0.9.2'

$OldPattern = @'
b$("codex",["exec","--sandbox","read-only","--output-last-message",b,c],{cwd:a.workspacePath,timeout:6e5,maxBuffer:8388608,env:process.env,shell:w()})
'@.TrimEnd()

$NewPattern = @'
b$(w()?"cmd.exe":"codex",w()?["/c","codex","exec","review","--output-last-message",b,"--dangerously-bypass-approvals-and-sandbox",c]:["exec","review","--output-last-message",b,"--dangerously-bypass-approvals-and-sandbox",c],{cwd:a.workspacePath,timeout:6e5,maxBuffer:8388608,env:process.env,shell:false})
'@.TrimEnd()

function Get-AoVersionFromText {
    param([string]$Text)
    if ($Text -match '(\d+)\.(\d+)\.(\d+)') {
        return [version](('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]))
    }
    if ($Text -match '(\d+)\.(\d+)') {
        return [version](('{0}.{1}.0' -f $Matches[1], $Matches[2]))
    }
    return $null
}

function Get-InstalledAoVersion {
    $ao = Get-Command ao -ErrorAction SilentlyContinue
    if (-not $ao) { return $null }

    $output = @(& ao --version 2>&1)
    if ($LASTEXITCODE -ne 0) { return $null }

    $text = (($output | Select-Object -First 3) -join ' ').Trim()
    return Get-AoVersionFromText $text
}

function Get-AoReviewChunkPath {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { return $null }

    $npmRoot = (& npm root -g 2>&1 | Select-Object -First 1).ToString().Trim()
    if (-not $npmRoot -or -not (Test-Path -LiteralPath $npmRoot -PathType Container)) { return $null }

    $path = Join-Path $npmRoot '@aoagents\ao\node_modules\@aoagents\ao-web\.next\server\chunks\4148.js'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    return $null
}

function Write-NoOp {
    param([string]$Message)
    Write-Host "patch-codex-review4.ps1: no-op - $Message"
    exit 0
}

if ($env:OS -notmatch 'Windows' -and -not $IsWindows) {
    Write-NoOp 'this patch applies only on Windows.'
}

$aoVersion = Get-InstalledAoVersion
if ($aoVersion) {
    Write-Host "Detected AO version: $aoVersion"
    if ($aoVersion -ge $FixedAoVersion) {
        Write-NoOp "AO $aoVersion includes the upstream Codex review fix; patch not required."
    }
    if ($aoVersion -lt $MinAffectedVersion) {
        Write-NoOp "AO $aoVersion is older than the affected 0.9.2 release; this patch does not apply."
    }
}
else {
    Write-Host 'Could not detect AO version (ao not on PATH or version parse failed); continuing with file-based checks.'
}

$chunkPath = Get-AoReviewChunkPath
if (-not $chunkPath) {
    Write-Host 'patch-codex-review4.ps1: AO review chunk not found under global npm install.'
    Write-Host 'Install AO with: npm install -g @aoagents/ao'
    exit 1
}

$content = Get-Content -LiteralPath $chunkPath -Raw -Encoding UTF8
$content = $content -replace "`r`n", "`n"

if ($content.Contains($NewPattern)) {
    Write-NoOp 'review chunk already contains the patched Codex invocation.'
}

if ($content.Contains($OldPattern)) {
    [System.IO.File]::WriteAllText($chunkPath, $content.Replace($OldPattern, $NewPattern), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Patched successfully: $chunkPath"
    exit 0
}

# Partial fix: review subcommand present but Windows shell splitting bug remains.
if ($content -match 'exec","review"' -and $content -match 'shell:w\(\)') {
    Write-Host 'patch-codex-review4.ps1: review chunk looks partially patched (exec review present, shell:w() still used).'
    Write-Host "File: $chunkPath"
    Write-Host 'Expected the full patched invocation (shell:false). Reinstall AO 0.9.2 and re-run this script.'
    exit 1
}

Write-Host 'patch-codex-review4.ps1: expected patch patterns not found in review chunk.'
Write-Host "File: $chunkPath"
Write-Host 'If you upgraded AO, confirm whether the built-in Windows Codex review still works.'
exit 1
