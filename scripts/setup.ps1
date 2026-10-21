[CmdletBinding()]
param(
    [string]$Python = 'python',
    [string]$BrowserPath,
    [switch]$SkipInstall,
    [switch]$WithOptionalVisuals,
    [switch]$Reconfigure
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$env:PYTHONUTF8 = '1'
$previousBrowserCache = $env:PLAYWRIGHT_BROWSERS_PATH
if (-not $BrowserPath) { $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $repo '.local/browsers' }
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Setup command failed: $Executable (exit $LASTEXITCODE)" }
}
Push-Location -LiteralPath $repo
try {
    foreach ($tool in @('node', 'npm', 'ffmpeg', 'ffprobe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool. See docs/安装与使用.md; setup does not install system-wide tools." }
    }
    if ([int]((& node --version) -replace '^v','').Split('.')[0] -lt 22) { throw 'Node.js >=22 is required.' }
    $venv = Join-Path $repo '.venv'
    $venvPython = if ($IsWindows) { Join-Path $venv 'Scripts/python.exe' } else { Join-Path $venv 'bin/python' }
    if (-not $SkipInstall) {
        if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-Checked $Python @('-m','venv',$venv) }
        $Python = $venvPython
        Invoke-Checked $Python @('-m','pip','install','-r',(Join-Path $repo 'requirements.txt'))
        Invoke-Checked 'npm' @('ci','--no-fund','--no-audit')
        Push-Location -LiteralPath (Join-Path $repo 'runtime/video-production-workflow')
        try { Invoke-Checked 'npm' @('ci','--no-fund','--no-audit'); Invoke-Checked 'npm' @('run','build') } finally { Pop-Location }
        if ($WithOptionalVisuals) {
            foreach ($relative in @('runtime/video-workspace/runtime/visual-lab','runtime/video-workspace/runtime/hyperframes','runtime/video-workspace/runtime/livecanvas-remotion')) {
                Push-Location -LiteralPath (Join-Path $repo $relative)
                try { Invoke-Checked 'npm' @('ci','--no-fund','--no-audit') } finally { Pop-Location }
            }
        }
        if (-not $BrowserPath) { Invoke-Checked $Python @('-m','playwright','install','chromium') }
    }
    $configure = @((Join-Path $PSScriptRoot 'configure.py'))
    if ($BrowserPath) { $configure += @('--browser',$BrowserPath) }
    if ($Reconfigure) { $configure += '--reconfigure' }
    Invoke-Checked $Python $configure
    & (Join-Path $PSScriptRoot 'director.ps1') style build
    if ($LASTEXITCODE -ne 0) { throw 'Style navigation build failed.' }
    Write-Output 'Configured. Next: pwsh -File scripts/smoke.ps1'
} finally { $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserCache; Pop-Location }
