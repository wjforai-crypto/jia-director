$ErrorActionPreference='Stop'
$forwardArguments=@($args)
$entry='E:\开发项目\jia-director-system\scripts\director.ps1'
if(-not(Test-Path -LiteralPath $entry)){throw "Director 2.0 runtime missing: $entry"}
& $entry @forwardArguments
exit $LASTEXITCODE
