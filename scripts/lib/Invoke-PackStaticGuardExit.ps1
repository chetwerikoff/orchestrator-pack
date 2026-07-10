#requires -Version 5.1

function Invoke-ConsumerModuleStaticGuard {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string[]]$ConsumerModules,

        [Parameter(Mandatory = $true)]
        [scriptblock]$ValidateModule
    )

    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($rel in $ConsumerModules) {
        $path = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $failures.Add("missing consumer module: $rel") | Out-Null
            continue
        }

        $text = Get-Content -LiteralPath $path -Raw
        & $ValidateModule $rel $text $failures
    }

    return @($failures)
}

function Complete-PackStaticGuard {
    param(
        [string[]]$Failures = @(),

        [Parameter(Mandatory = $true)]
        [string]$PassMessage
    )

    if ($Failures.Count -gt 0) {
        foreach ($item in $Failures) {
            Write-Host "[FAIL] $item"
        }
        exit 1
    }

    Write-Host $PassMessage
    exit 0
}
