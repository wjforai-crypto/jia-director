[CmdletBinding()]
param(
  [ValidateSet('doctor','probe','core','render','source-doctor','source-check','source-render','rough-prepare','rough-review','rough-suggest','rough-save','rough-export','fine-cut-plan','fine-cut-render','stage-status','stage-select','stage-save','stage-export','visual-task','visual-motion','visual-import-results','visual-asset-import','materials','talkcraft-export-words','talkcraft-import-edl')]
  [string]$Command='doctor',
  [string]$ProjectDir,
  [string]$InputPath,
  [string]$OutputPath,
  [string[]]$CoreArgs=@(),
  [string[]]$ToolArgs=@()
)
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$configPath=Join-Path $workspace 'config/video-workflow.json'
if(-not(Test-Path -LiteralPath $configPath)){throw 'Run scripts/setup.ps1 from the repository root first.'}
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Invoke-Checked([string]$Executable,[string[]]$Arguments){
  & $Executable @Arguments
  if($LASTEXITCODE -ne 0){throw "Command failed: $Executable (exit $LASTEXITCODE)"}
}
function Invoke-Adapter([string]$File,[string]$Action,[bool]$WithConfig=$false){
  $script=Join-Path $PSScriptRoot $File
  if($ToolArgs.Count -eq 1 -and $ToolArgs[0] -eq '--help'){Invoke-Checked $config.tools.nodeCommand @($script,'--help');return}
  $arguments=@($script,$Action)
  if($WithConfig){
    if($ToolArgs -contains '--config'){throw 'Use the generated workspace config; do not override --config here.'}
    $arguments+=@('--config',$configPath)
  }
  Invoke-Checked $config.tools.nodeCommand ($arguments+$ToolArgs)
}
switch($Command){
  'doctor' {Invoke-Checked $config.tools.nodeCommand @((Join-Path $PSScriptRoot 'portable-doctor.mjs'),$configPath)}
  'probe' {
    if(-not $InputPath){throw 'InputPath is required.'}
    Invoke-Checked $config.tools.ffprobeCommand @('-v','error','-show_streams','-show_format','-of','json',$InputPath)
  }
  'core' {
    if($CoreArgs.Count -eq 1 -and $CoreArgs[0] -eq '--help'){
      Write-Output 'Formal editing-contract core: see runtime/video-production-workflow/README.md for commands and project state requirements.'
      break
    }
    if(-not(Test-Path -LiteralPath $config.coreCli)){throw 'Build runtime/video-production-workflow first (setup.ps1 does this).'}
    Invoke-Checked $config.tools.nodeCommand (@($config.coreCli)+$CoreArgs)
  }
  'source-doctor' {Invoke-Adapter 'source-film.mjs' 'doctor' $true}
  'source-check' {Invoke-Adapter 'source-film.mjs' 'check' $true}
  'source-render' {Invoke-Adapter 'source-film.mjs' 'render' $true}
  'rough-prepare' {Invoke-Adapter 'rough-review.mjs' 'prepare' $true}
  'rough-review' {Invoke-Adapter 'rough-review.mjs' 'serve' $true}
  'rough-suggest' {Invoke-Adapter 'rough-review.mjs' 'suggest' $true}
  'rough-save' {Invoke-Adapter 'rough-review.mjs' 'save' $true}
  'rough-export' {Invoke-Adapter 'rough-review.mjs' 'export' $true}
  'fine-cut-plan' {Invoke-Adapter 'fine-cut.mjs' 'plan'}
  'fine-cut-render' {Invoke-Adapter 'fine-cut.mjs' 'render'}
  'stage-status' {Invoke-Adapter 'review-stages.mjs' 'status' $true}
  'stage-select' {Invoke-Adapter 'review-stages.mjs' 'select' $true}
  'stage-save' {Invoke-Adapter 'review-stages.mjs' 'save' $true}
  'stage-export' {Invoke-Adapter 'review-stages.mjs' 'export' $true}
  'visual-task' {Invoke-Adapter 'review-stages.mjs' 'task' $true}
  'visual-motion' {Invoke-Adapter 'review-stages.mjs' 'motion' $true}
  'visual-import-results' {Invoke-Adapter 'review-stages.mjs' 'import-results' $true}
  'visual-asset-import' {Invoke-Adapter 'review-stages.mjs' 'import-asset' $true}
  'talkcraft-export-words' {Invoke-Adapter 'talkcraft-bridge.mjs' 'export-words'}
  'talkcraft-import-edl' {Invoke-Adapter 'talkcraft-bridge.mjs' 'import-edl'}
  'materials' {Invoke-Checked $config.tools.python312 (@((Join-Path $PSScriptRoot 'material-library.py'))+$ToolArgs)}
  'render' {
    if(-not $ProjectDir -or -not $OutputPath){throw 'ProjectDir and a new OutputPath are required.'}
    if(Test-Path -LiteralPath $OutputPath){throw 'Output exists; choose a new version.'}
    $env:VIDEO_HYPERFRAMES_BROWSER_PATH=$config.render.browserPath
    Invoke-Checked $config.tools.nodeCommand (@($config.render.hyperframesLauncher,'render',$ProjectDir,'--output',$OutputPath)+$ToolArgs)
  }
}
