param([string]$AgentBrowserVersion = 'latest', [string]$BrowseVersion = 'latest', [string]$BrowserUseVersion = '')
$ErrorActionPreference = 'Stop'
$root = 'D:\dev\bench-tmp'
New-Item -ItemType Directory -Force -Path $root | Out-Null
# All package caches, build temporaries and install destinations stay in bench-tmp.
$names = @('TEMP','TMP','npm_config_cache','PIP_CACHE_DIR','PYTHONUSERBASE','PLAYWRIGHT_BROWSERS_PATH','XDG_CACHE_HOME')
$saved = @{}
try {
    foreach ($name in $names) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        $value = Join-Path $root $name
        New-Item -ItemType Directory -Force -Path $value | Out-Null
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    & npm.cmd install --prefix "$root\npm" --no-audit --no-fund "agent-browser@$AgentBrowserVersion" "@opencode/browse@$BrowseVersion"
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    & py -3.11 -m venv "$root\venv"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required' }
    $package = if ($BrowserUseVersion) { "browser-use==$BrowserUseVersion" } else { 'browser-use' }
    & "$root\venv\Scripts\python.exe" -m pip install $package
    if ($LASTEXITCODE -ne 0) { throw 'browser-use installation failed' }
    & "$root\venv\Scripts\python.exe" -m pip freeze | Set-Content "$root\python-freeze.txt"
    if ($LASTEXITCODE -ne 0) { throw 'pip freeze failed' }
    & npm.cmd ls --prefix "$root\npm" --json | Set-Content "$root\npm-versions.json"
    if ($LASTEXITCODE -ne 0) { throw 'npm version capture failed' }
    Write-Host 'Packages installed locally. No global install, extension pairing, skill registration, or browser download was performed.'
    Write-Host 'Use a coordinator setup hook for browse/Browser Use; provide an existing Chromium executable for agent-browser if its default browser is unavailable.'
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
