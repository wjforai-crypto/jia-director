"""Create machine-local paths; never copy the author's private configuration."""
import argparse
import json
from pathlib import Path
import shutil
import sys

p = argparse.ArgumentParser()
p.add_argument('--browser')
p.add_argument('--reconfigure', action='store_true')
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
workspace = root / 'runtime/video-workspace'
config_path = workspace / 'config/video-workflow.json'
if config_path.exists() and not a.reconfigure:
    raise SystemExit('Configuration already exists. Preserve it; pass -Reconfigure explicitly to replace machine-local paths.')
if a.browser:
    browser = Path(a.browser).resolve()
else:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = Path(pw.chromium.executable_path)
if not browser.is_file():
    raise SystemExit('Chromium is missing. Install with python -m playwright install chromium or supply -BrowserPath.')
if not (root/'node_modules/playwright/package.json').is_file():
    raise SystemExit('Run npm ci in the repository root first.')
text = lambda p: str(p.resolve())
tools = {k+'Command': shutil.which(k) or k for k in ('node','ffmpeg','ffprobe')}
tools.update(minimumNodeMajor=22, python312=sys.executable)
cfg = {
    'schemaVersion':1, 'kind':'video-workspace-runtime-configuration', 'publicDistribution':True,
    'workspaceRoot':text(workspace), 'asciiWorkspaceAlias':text(workspace),
    'coreCli':text(root/'runtime/video-production-workflow/dist/src/cli.js'), 'tools':tools,
    'sourceFilm':{'version':'0.1.0','playwrightModule':text(root/'node_modules/playwright'),'defaultWorkers':2},
    'render':{'browserPath':str(browser),'defaultBackend':'hyperframes','workers':2,'fpsFallback':30,
              'hyperframesVersion':'0.7.103','hyperframesLauncher':text(workspace/'runtime/hyperframes/run-hyperframes.mjs'),
              'motionGsapPath':text(workspace/'runtime/motion/gsap.min.js'),
              'existingProjectSettingsTakePrecedence':True},
    'dataCharts':{'runtimeProject':text(workspace/'runtime/livecanvas-remotion'),
                  'launcher':text(root/'skills/jia-director/scripts/render-data-chart.mjs'),
                  'nativeCanvas':{'width':1080,'height':1440,'fps':30,'durationInFrames':90}},
    'materials':{'libraryRoot':text(root/'.local/materials'),'launcher':text(workspace/'skill-src/jia-video/scripts/material-library.py'),
                 'defaultSearchProvider':'local','automaticCandidateAdoption':False,'maxDownloadBytes':104857600,'downloadDeadlineSeconds':90},
    'asr':{'engine':'whisper.cpp','executable':text(workspace/'runtime/whisper/whisper-cli.exe'),
           'modelPath':text(workspace/'runtime/whisper/ggml-small.bin'),'jobsRoot':text(root/'.local/asr-jobs'),
           'modelName':'multilingual-small','language':'zh','reviewRequired':True,'coreImportEngine':'import'},
    'voice':{'talkingHead':'preserve-source-audio','productionMode':'local-first-personal-sample-required',
             'productionVoiceId':None,'productionVoiceStatus':'not-configured','preferredProvider':'local',
             'previewAcceptedAsProduction':False,'remoteVoiceEnabled':False},
    'generatedVideo':{'automaticExecutionEnabled':False,'defaultPaidBudgetAuthorized':False},
    'images':{'defaultBackend':'host-built-in-image-tool','localApiKeyRequired':False},
    'implementationBoundaries':{'productionTtsAdapter':False,'automaticPaidVideo':False},
    'optionalModules':{'asr':'not-installed','personalTts':'not-installed','privateMedia':'not-included','externalStyleSources':'reference-links-only'}
}
config_path.parent.mkdir(parents=True,exist_ok=True)
config_path.write_text(json.dumps(cfg,ensure_ascii=False,indent=2),encoding='utf-8')
visual = {'kind':'jia-visual-backend-runtime','version':'0.1.0','browserPath':str(browser),
          'playwrightPackage':text(root/'node_modules/playwright'),'hyperframesLauncher':cfg['render']['hyperframesLauncher'],
          'remotionRuntime':cfg['dataCharts']['runtimeProject'],'asciiRuntime':text(workspace/'runtime/visual-lab'),
          'baselineProject':text(root/'.local/unverified-baseline'),
          'expectedPackages':{'three':'0.181.2','p5':'2.2.3','p5.brush':'2.2.3'},
          'defaultVideoApi':'disabled','userAcceptanceRequired':True}
(workspace/'runtime/visual-lab/runtime.json').write_text(json.dumps(visual,ensure_ascii=False,indent=2),encoding='utf-8')
spec = {'schemaVersion':1,'mode':'reference-original','source':{'root':text(root/'examples/source-demo'),'files':['index.html']},
        'video':{'width':640,'height':360,'fps':30,'duration':3,'audio':'silent'},
        'renderer':{'kind':'browser','entry':'index.html','seek':'renderAt','ready':'ready','state':'stateAt','capture':'canvas'},
        'time':{'offset':0,'rate':1},'requireExactSeek':True,
        'checkpoints':[{'at':1.5,'objectId':'ball','expectSingle':True,'maxStepPixels':20}]}
(root/'.local').mkdir(exist_ok=True)
(root/'.local/source-demo.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'configuration':str(config_path),'python':sys.executable,'browser':str(browser),'paidVideoEnabled':False},ensure_ascii=False))
