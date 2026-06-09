BeforeAll {
    . (Join-Path $PSScriptRoot 'lib/Get-OrchestratorLaunchHealth.ps1')
}

Describe 'Test-SessionRuntimeFieldLive (Issue #250)' {
    It 'treats absent runtime as live at field level' {
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ status = 'working' }) | Should -Be $true
    }

    It 'accepts affirmative alive' {
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = 'alive' }) | Should -Be $true
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = 'ALIVE' }) | Should -Be $true
    }

    It 'rejects terminal death and present unknown values' {
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = 'exited' }) | Should -Be $false
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = 'process_missing' }) | Should -Be $false
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = 'unreachable' }) | Should -Be $false
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = '' }) | Should -Be $false
        Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime = $null }) | Should -Be $false
    }
}

Describe 'Test-OrchestratorSessionLaunchHealthy' {
    It 'keeps orchestrator status disqualifiers independent of runtime relaxation' {
        Test-OrchestratorSessionLaunchHealthy -Session ([pscustomobject]@{
                status   = 'stuck'
                activity = 'idle'
            }) | Should -Be $false
        Test-OrchestratorSessionLaunchHealthy -Session ([pscustomobject]@{
                status   = 'working'
                activity = 'exited'
            }) | Should -Be $false
    }

    It 'passes working orchestrator without runtime field' {
        Test-OrchestratorSessionLaunchHealthy -Session ([pscustomobject]@{
                status   = 'working'
                activity = 'ready'
            }) | Should -Be $true
    }
}
