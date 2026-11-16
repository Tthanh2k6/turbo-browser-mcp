param(
    [Parameter(Mandatory=$true)][string]$CodexPath,
    [Parameter(Mandatory=$true)][string]$Model,
    [string]$Reasoning = 'medium',
    [string]$SetupHook = '',
    [string]$ChromiumPath = ''
)
$ErrorActionPreference = 'Stop'
& node "$PSScriptRoot\runner.mjs" --codex $CodexPath --model $Model --reasoning $Reasoning --hook $SetupHook --chromium $ChromiumPath
if ($LASTEXITCODE -ne 0) { throw "Benchmark runner exited with code $LASTEXITCODE" }
