$forwardArguments = @($args)
$ErrorActionPreference = 'Stop'
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime/video-workspace/scripts/video.ps1'
& $entry @forwardArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
