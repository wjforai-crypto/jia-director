$cliArguments = @($args)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$configPath = if ($env:JIA_VIDEO_CONFIG) { $env:JIA_VIDEO_CONFIG } else { Join-Path (Split-Path -Parent $project) 'video-workspace/config/video-workflow.json' }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Run scripts/setup.ps1 from the public repository first.' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$python = $config.tools.python312
$previousConfig = $env:JIA_VIDEO_CONFIG
$previousPythonPath = $env:PYTHONPATH
$env:JIA_VIDEO_CONFIG = $configPath
$env:PYTHONPATH = if ($previousPythonPath) { $project + [IO.Path]::PathSeparator + $previousPythonPath } else { $project }
try {
    & $python -X utf8 -m jia_director @cliArguments
    $code = $LASTEXITCODE
} finally {
    $env:JIA_VIDEO_CONFIG = $previousConfig
    $env:PYTHONPATH = $previousPythonPath
}
exit $code
