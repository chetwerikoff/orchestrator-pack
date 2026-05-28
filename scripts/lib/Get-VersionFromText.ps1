function Get-VersionFromText {
    param([string]$Text)
    if ($Text -match '(\d+)\.(\d+)\.(\d+)') {
        return [version](('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]))
    }
    if ($Text -match '(\d+)\.(\d+)') {
        return [version](('{0}.{1}.0' -f $Matches[1], $Matches[2]))
    }
    return $null
}
