[CmdletBinding()]
param([string]$OutputRoot)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
if(-not $OutputRoot){$OutputRoot=Join-Path $repo ('.local/smoke-'+[Guid]::NewGuid().ToString('N'))}
if(Test-Path -LiteralPath $OutputRoot){throw 'Choose a new output directory.'}
New-Item -ItemType Directory -Path $OutputRoot | Out-Null
Push-Location -LiteralPath $repo
try {
  & (Join-Path $PSScriptRoot 'video.ps1') -Command doctor
  if($LASTEXITCODE -ne 0){throw 'Workspace doctor failed.'}
  & (Join-Path $PSScriptRoot 'director.ps1') doctor --out (Join-Path $OutputRoot 'director-doctor.json')
  if($LASTEXITCODE -ne 0){throw 'Director browser doctor failed.'}
  & (Join-Path $PSScriptRoot 'director.ps1') clip render --spec (Join-Path $repo 'examples/director-smoke.json') --out (Join-Path $OutputRoot 'director')
  if($LASTEXITCODE -ne 0){throw 'Director render failed.'}
  & (Join-Path $PSScriptRoot 'video.ps1') -Command source-render -ToolArgs @('--spec',(Join-Path $repo '.local/source-demo.json'),'--output',(Join-Path $OutputRoot 'source-film'),'--workers','2')
  if($LASTEXITCODE -ne 0){throw 'Source-film render failed.'}
  Write-Output "Technical exports completed. Review the MP4s in $OutputRoot; this is not artistic approval."
} finally {Pop-Location}
