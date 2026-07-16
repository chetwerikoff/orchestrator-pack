import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '#opk-kernel/subprocess';

export interface GhMergedJsonFinding {
  file: string;
  line: number;
  command: string;
  reason: 'merged-gh-json-stream';
}

const parserScript = String.raw`param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$payload = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$findings = @()
foreach ($file in @($payload.files)) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile([string]$file, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -gt 0) { throw "PowerShell parse failed for $file: $($errors[0].Message)" }

  $assignments = @{}
  foreach ($assignment in @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))) {
    if ($assignment.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
      $assignments[$assignment.Left.VariablePath.UserPath.ToLowerInvariant()] = $assignment.Right.Extent.Text
    }
  }
  $jsonParsers = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'ConvertFrom-Json'
  }, $true))

  foreach ($command in @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))) {
    $text = $command.Extent.Text
    $name = [string]$command.GetCommandName()
    $isGh = $name -match '^(?i:gh(?:\.exe)?)$' -or $name -match '(?i)(?:^|[/\\])scripts[/\\]gh$'
    if (-not $isGh -and $command.CommandElements.Count -gt 0 -and $command.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst]) {
      $variableName = $command.CommandElements[0].VariablePath.UserPath.ToLowerInvariant()
      $resolved = [string]$assignments[$variableName]
      $isGh = $resolved -match '(?i)(?:^|[/\\''"])(?:gh(?:\.exe)?|scripts[/\\]gh)(?:$|[/\\''"])'
    }
    if (-not $isGh) {
      $isGh = $text -match '(?is)(?:^|[\s&(''"])(?:gh(?:\.exe)?|[^\r\n]*scripts[/\\]gh)(?:\s|$)'
    }
    if (-not $isGh) { continue }

    $merged = @($command.Redirections | Where-Object { $_.Extent.Text -match '^\s*2\s*>&\s*1\s*$' }).Count -gt 0
    if (-not $merged) { $merged = $text -match '(?s)2\s*>&\s*1' }
    if (-not $merged) { continue }

    $explicitJson = $text -match '(?is)(?:--json\b|(?:^|\s)api(?:\s|$))'
    $parsedLater = $false
    $pipeline = $command.Parent
    while ($pipeline -and -not ($pipeline -is [System.Management.Automation.Language.PipelineAst])) { $pipeline = $pipeline.Parent }
    if ($pipeline -and $pipeline.Extent.Text -match '(?i)ConvertFrom-Json') { $parsedLater = $true }

    $assignment = $command.Parent
    while ($assignment -and -not ($assignment -is [System.Management.Automation.Language.AssignmentStatementAst])) { $assignment = $assignment.Parent }
    if ($assignment -and $assignment.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
      $variable = $assignment.Left.VariablePath.UserPath
      foreach ($parser in $jsonParsers) {
        if ($parser.Extent.StartOffset -gt $assignment.Extent.EndOffset -and $parser.Extent.Text -match ('(?i)\$' + [regex]::Escape($variable) + '\b')) {
          $parsedLater = $true
          break
        }
      }
    }
    if (-not ($explicitJson -or $parsedLater)) { continue }

    $relative = [string]$file
    if ($payload.repoRoot) { $relative = [IO.Path]::GetRelativePath([string]$payload.repoRoot, [string]$file).Replace('\\','/') }
    $narrow = $relative -eq 'scripts/lib/Ci-Failure-Notification-Common.ps1' -and -not $parsedLater -and $text -match '(?is)^\s*gh\s+repo\s+view\s+--json\s+nameWithOwner\s+2\s*>&\s*1\s*$'
    if ($narrow) { continue }
    $findings += [ordered]@{
      file = $relative
      line = $command.Extent.StartLineNumber
      command = $text.Trim()
      reason = 'merged-gh-json-stream'
    }
  }
}
$findings | ConvertTo-Json -Depth 8 -Compress
`;

export function scanPowerShellGhMergedJson(files: string[], repoRoot = ''): GhMergedJsonFinding[] {
  if (files.length === 0) return [];
  const temp = mkdtempSync(path.join(tmpdir(), 'gh-signal-recon-'));
  try {
    const parserPath = path.join(temp, 'scan.ps1');
    const inputPath = path.join(temp, 'input.json');
    writeFileSync(parserPath, parserScript, 'utf8');
    writeFileSync(inputPath, JSON.stringify({ files, repoRoot }), 'utf8');
    const result = runProcessSync({
      command: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', parserPath, '-InputPath', inputPath],
      encoding: 'utf8',
      inheritParentEnv: true,
    });
    if (!result.ok) throw new Error(`gh signal recon failed: ${result.stderr || result.stdout}`);
    const text = result.stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
