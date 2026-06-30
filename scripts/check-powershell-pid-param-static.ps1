#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: forbid $Pid parameter names in scripts/**/*.ps1 (Issue #534).

  PowerShell treats $Pid and $PID as the same symbol; $PID is automatic and read-only.
  Uses the PowerShell parser AST so comments/strings/documentation examples are ignored.
#>
param(
    [string]$ScriptsRoot = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not $ScriptsRoot) {
    $ScriptsRoot = Join-Path $Root 'scripts'
}

function Test-ParameterAstDeclaresPid {
    param([System.Management.Automation.Language.ParameterAst]$ParameterAst)

    if (-not $ParameterAst -or -not $ParameterAst.Name) {
        return $false
    }

    $name = $ParameterAst.Name.VariablePath.UserPath
    return $name.Equals('pid', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PidParamDeclarationInFile {
    param([string]$FilePath)

    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($FilePath, [ref]$null, [ref]$parseErrors)
    if (-not $ast) {
        return $false
    }

    $paramBlocks = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.ParamBlockAst]
        }, $true)
    foreach ($block in $paramBlocks) {
        foreach ($param in $block.Parameters) {
            if (Test-ParameterAstDeclaresPid -ParameterAst $param) {
                return $true
            }
        }
    }

    $functions = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
        }, $true)
    foreach ($func in $functions) {
        foreach ($param in $func.Parameters) {
            if (Test-ParameterAstDeclaresPid -ParameterAst $param) {
                return $true
            }
        }
    }

    return $false
}

$violations = @()
Get-ChildItem -LiteralPath $ScriptsRoot -Filter '*.ps1' -Recurse -File | ForEach-Object {
    if (Test-PidParamDeclarationInFile -FilePath $_.FullName) {
        if ($_.FullName.StartsWith($ScriptsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relative = $_.FullName.Substring($ScriptsRoot.Length).TrimStart([char]'\', [char]'/')
        }
        else {
            $relative = $_.FullName
        }
        $violations += $relative
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] PowerShell $Pid parameter declarations found (Issue #534):'
    foreach ($file in $violations) {
        Write-Host "  $file"
    }
    exit 1
}

Write-Host '[PASS] PowerShell $Pid parameter static guard (Issue #534)'
exit 0
