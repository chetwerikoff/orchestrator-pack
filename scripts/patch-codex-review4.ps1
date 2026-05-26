$file = "C:\Users\che\AppData\Roaming\npm\node_modules\@aoagents\ao\node_modules\@aoagents\ao-web\.next\server\chunks\4148.js"
$content = Get-Content $file -Raw -Encoding UTF8
$content = $content -replace "`r`n", "`n"

$old = 'b$("codex",["exec","--sandbox","read-only","--output-last-message",b,c],{cwd:a.workspacePath,timeout:6e5,maxBuffer:8388608,env:process.env,shell:w()})'

$new = 'b$(w()?"cmd.exe":"codex",w()?["/c","codex","exec","review","--output-last-message",b,"--dangerously-bypass-approvals-and-sandbox",c]:["exec","review","--output-last-message",b,"--dangerously-bypass-approvals-and-sandbox",c],{cwd:a.workspacePath,timeout:6e5,maxBuffer:8388608,env:process.env,shell:false})'

if ($content.Contains($old)) {
    [System.IO.File]::WriteAllText($file, $content.Replace($old, $new), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Patched successfully"
} else {
    Write-Host "Pattern not found"
}
