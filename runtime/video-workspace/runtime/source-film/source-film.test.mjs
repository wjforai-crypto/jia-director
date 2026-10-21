import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {validateSpec,assessObjects,verifyVideo} from './source-film.mjs';
const workspace=path.resolve(import.meta.dirname,'../..');
const fixture={schemaVersion:1,mode:'source-adaptation',source:{root:'.',files:['index.html']},video:{width:320,height:180,fps:12,duration:0.5,audio:'silent'},renderer:{kind:'browser',entry:'index.html',seek:'seek',ready:'ready',state:'stateAt',capture:'#out'},checkpoints:[{at:.25,objectId:'dot',expectSingle:true,maxStepPixels:20}]};
test('rejects invalid contracts and detects the actual duplicate/missing/jump failure classes',()=>{
  assert.equal(validateSpec(structuredClone(fixture)).mode,'source-adaptation');
  for(const patch of [{video:{...fixture.video,duration:.123}},{renderer:{...fixture.renderer,seek:'seek();fetch(1)'}},{checkpoints:[{at:2}]}])assert.throws(()=>validateSpec({...fixture,...patch}));
  const object=x=>({objects:[{id:'dot',space:'screen',x,y:50}]});
  assert.deepEqual(assessObjects(fixture.checkpoints[0],[object(20),object(25),object(30)]),[]);
  assert.match(assessObjects(fixture.checkpoints[0],[object(20),object(353)])[0],/Screen step/);
  assert.match(assessObjects(fixture.checkpoints[0],[{objects:[]}])[0],/found 0/);
  assert.match(assessObjects(fixture.checkpoints[0],[{objects:[...object(20).objects,...object(20).objects]}])[0],/found 2/);
});
test('three workers render a real movie; all frames decode; wrong specs and overwrites fail',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jia-source-film-test-'));
  const html='<canvas id="out" width="320" height="180"></canvas><script>window.ready=true; window.stateAt=t=>({objects:[{id:"dot",space:"screen",x:40+t*40,y:90}]}); window.seek=t=>{const c=document.querySelector("canvas").getContext("2d"); c.fillStyle="#faf0df";c.fillRect(0,0,320,180);c.fillStyle="#e1733c";c.fillRect(40+t*40,80,20,20);};</script>';
  await fs.writeFile(path.join(root,'index.html'),html);
  const spec={...fixture,source:{root,files:['index.html']}};await fs.writeFile(path.join(root,'spec.json'),JSON.stringify(spec));
  const output=path.join(root,'job'),args=[path.join(workspace,'scripts/source-film.mjs'),'render','--config',path.join(workspace,'config/video-workflow.json'),'--spec',path.join(root,'spec.json'),'--output',output,'--workers','3'];
  const p=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(p.status,0,p.stdout+p.stderr);
  const receipt=JSON.parse(await fs.readFile(path.join(output,'receipt.json'),'utf8'));assert.equal(receipt.status,'TECHNICAL_RENDER_PASSED');assert.equal(receipt.video.actual.frames,6);assert.equal(receipt.seek.stateExact,true);assert.equal(receipt.errors.length,0);assert.equal(receipt.userAccepted,false);
  const cfg=JSON.parse(await fs.readFile(path.join(workspace,'config/video-workflow.json'),'utf8'));
  const wrong=await verifyVideo(path.join(output,'render.mp4'),{...fixture.video,fps:24},cfg.tools);assert.equal(wrong.passed,false);assert.ok(wrong.issues.includes('fps mismatch'));
  const before=await fs.readFile(path.join(output,'receipt.json'),'utf8');const again=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:60000});assert.notEqual(again.status,0);assert.equal(await fs.readFile(path.join(output,'receipt.json'),'utf8'),before);
  console.log(JSON.stringify({artifactRoot:root,actualFrames:6,workers:3}));
});
test('a child command that returns zero without a movie cannot report success',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jia-source-false-success-'));await fs.writeFile(path.join(root,'source.txt'),'fixture');
  const spec={...fixture,source:{root,files:['source.txt']},renderer:{kind:'command',executable:process.execPath,args:['-e','process.exit(0)','{output}']},checkpoints:[]};
  await fs.writeFile(path.join(root,'spec.json'),JSON.stringify(spec));const out=path.join(root,'job');
  const p=spawnSync(process.execPath,[path.join(workspace,'scripts/source-film.mjs'),'render','--config',path.join(workspace,'config/video-workflow.json'),'--spec',path.join(root,'spec.json'),'--output',out],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.notEqual(p.status,0);const r=JSON.parse(await fs.readFile(path.join(out,'receipt.json'),'utf8'));assert.equal(r.status,'FAILED');assert.equal(r.encoder.exitCode,0);assert.equal(r.output,undefined);
});
