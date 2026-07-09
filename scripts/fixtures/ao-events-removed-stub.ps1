#requires -Version 5.1
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
if ($Args -contains 'events') {
    Write-Output 'unknown command "events" for "ao"'
    exit 1
}
Write-Output '{"events":[]}'
exit 0
