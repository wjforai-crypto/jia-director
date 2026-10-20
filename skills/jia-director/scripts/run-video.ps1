[CmdletBinding()]
param(
  [ValidateSet('doctor','probe','core','transcribe','preview-voice','render','source-doctor','source-check','source-render','rough-prepare','rough-review','rough-suggest','rough-save','rough-export','fine-cut-plan','fine-cut-render','stage-status','stage-select','stage-save','stage-export','visual-task','visual-motion','visual-import-results','visual-asset-import','materials','talkcraft-export-words','talkcraft-import-edl','voice-doctor','voice-prepare','voice-synthesize','voice-enroll','voice-batch')]
  [string]$Command = 'doctor',
  [string]$Workspace = 'E:\开发项目\视频剪辑skill',
  [string]$ProjectDir,
  [string]$InputPath,
  [string]$OutputPath,
  [string]$Text,
  [string[]]$CoreArgs = @(),
  [string[]]$ToolArgs = @()
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath($Workspace)
$runtimeScript = Join-Path $runtimeRoot 'scripts\video.ps1'
$runtimeConfig = Join-Path $runtimeRoot 'config\video-workflow.json'
if (-not (Test-Path -LiteralPath $runtimeScript -PathType Leaf) -or -not (Test-Path -LiteralPath $runtimeConfig -PathType Leaf)) {
  throw "Configured video workspace is unavailable: $runtimeRoot. Set -Workspace to its current location; do not silently reinstall tools."
}
$configuration = Get-Content -LiteralPath $runtimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($configuration.kind -ne 'video-workspace-runtime-configuration' -or [IO.Path]::GetFullPath($configuration.workspaceRoot).TrimEnd('\') -ne $runtimeRoot.TrimEnd('\')) {
  throw 'Workspace configuration does not match this runtime root.'
}
$arguments = @{Command=$Command}
foreach ($argumentName in @('ProjectDir','InputPath','OutputPath','Text')) {
  if ($PSBoundParameters.ContainsKey($argumentName)) { $arguments[$argumentName]=$PSBoundParameters[$argumentName] }
}
if ($CoreArgs.Count -gt 0) { $arguments.CoreArgs=$CoreArgs }
if ($ToolArgs.Count -gt 0) { $arguments.ToolArgs=$ToolArgs }
& $runtimeScript @arguments
