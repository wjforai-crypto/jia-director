$forwardArguments = @($args)
$ErrorActionPreference = 'Stop'
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime/jia-director-system/scripts/director.ps1'
& $entry @forwardArguments
exit $LASTEXITCODE
