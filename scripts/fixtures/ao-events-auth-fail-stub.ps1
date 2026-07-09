#requires -Version 5.1
if ($args -contains 'events') {
    Write-Error 'authentication required'
    exit 1
}
exit 0
