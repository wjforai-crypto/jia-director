import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const file=process.argv[2];
const cfg=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const tools=Object.fromEntries(['node','ffmpeg','ffprobe'].map(name=>{
  const r=spawnSync(cfg.tools[name+'Command'],[name==='node'?'--version':'-version'],{encoding:'utf8',windowsHide:true});
  return [name,{ready:!r.error&&r.status===0,version:r.stdout?.split('\n')[0]?.trim()??null}];
}));
const files={browser:cfg.render.browserPath,python:cfg.tools.python312,coreCli:cfg.coreCli,playwright:path.join(cfg.sourceFilm.playwrightModule,'package.json')};
const requiredFiles=Object.fromEntries(Object.entries(files).map(([name,file])=>[name,{ready:fs.existsSync(file),file}]));
const result={kind:'jia-public-workspace-doctor',baseReady:Object.values(tools).every(t=>t.ready)&&Object.values(requiredFiles).every(f=>f.ready),tools,requiredFiles,
 optional:{asr:fs.existsSync(cfg.asr.executable)&&fs.existsSync(cfg.asr.modelPath),personalVoice:false,
 hyperframes:fs.existsSync(path.join(cfg.workspaceRoot,'runtime/hyperframes/node_modules/hyperframes/package.json')),
 visualLibraries:fs.existsSync(path.join(cfg.workspaceRoot,'runtime/visual-lab/node_modules/three/package.json')),
 livecanvas:fs.existsSync(path.join(cfg.workspaceRoot,'runtime/livecanvas-remotion/node_modules/@remotion/renderer/package.json'))},
 paidVideoEnabled:false,scope:'Presence/version check only. Run smoke.ps1 for actual export and decode; artistic and voice acceptance remain separate.'};
console.log(JSON.stringify(result,null,2));
if(!result.baseReady)process.exitCode=1;
