// Explicit installed-browser QA; this does not record user approval.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { serveReview, native, hashFile } from '../rough-review.mjs';
const root=resolve('.'),cfg=JSON.parse(await readFile(join(root,'config/video-workflow.json'),'utf8'));
const require=createRequire(pathToFileURL(join(root,'runtime/hyperframes/package.json'))),puppeteer=require('puppeteer-core');
const fixture=resolve(process.argv[2]??'checks/2026-10-10/local-rough-review/browser-361f48b5-5d09-4a3f-9912-e4c866834951/review');
const out=join(root,'checks/2026-10-10/stage-continuation','browser-'+randomUUID()),dir=join(out,'review');await mkdir(out,{recursive:true});await cp(fixture,dir,{recursive:true,force:false,errorOnExist:true});
const service=await serveReview(dir),browser=await puppeteer.launch({executablePath:cfg.render.browserPath,headless:true,args:['--autoplay-policy=no-user-gesture-required'],defaultViewport:{width:1440,height:1000}}),page=await browser.newPage();
const errors=[],external=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(service.url)&&!r.url().startsWith('data:'))external.push(r.url());});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function change(selector,value){await page.$eval(selector,(n,v)=>{n.value=v;n.dispatchEvent(new Event('change',{bubbles:true}));},String(value));}
async function waitJob(){await page.waitForFunction(async()=>{const job=await(await fetch('/api/stages/job')).json();return job.status!=='running';},{timeout:300000});const job=await page.evaluate(async()=>await(await fetch('/api/stages/job')).json());assert.equal(job.status,'done',JSON.stringify(job));await page.waitForFunction(()=>!document.getElementById('motionCreate').disabled,{timeout:10000});return job.result;}
try{
  await page.goto(service.url,{waitUntil:'networkidle0'});await page.waitForSelector('[data-unit]');
  check('rough stage remains functional',await page.$eval('#roughPage',n=>!n.hidden));
  await page.click('.workflow [data-stage="fine"]');await page.waitForFunction(()=>document.body.dataset.stage==='fine');await page.click('#fineBind');await page.waitForSelector('[data-clip="0"]');await page.waitForFunction(()=>document.getElementById('fineVideo').readyState>=2);
  check('fine source is frozen rough export with two original joins',await page.$$eval('.fine-clip',n=>n.length===2));
  const left=await page.$eval('[data-clip="0"][data-boundary="endFrameExclusive"]',n=>Number(n.value));const right=await page.$eval('[data-clip="1"][data-boundary="startFrame"]',n=>Number(n.value));
  await change('[data-clip="0"][data-boundary="endFrameExclusive"]',left-1);await change('[data-clip="1"][data-boundary="startFrame"]',right+1);
  await page.click('[data-listen="1"]');await new Promise(r=>setTimeout(r,1500));check('join audition plays actual source',await page.$eval('#fineVideo',v=>v.getVideoPlaybackQuality().totalVideoFrames>0));
  await page.$eval('#fineVideo',v=>v.pause());await page.click('#fineSave');await page.waitForFunction(()=>document.getElementById('fineStatus').textContent.includes('r1'));
  await page.screenshot({path:join(out,'01-fine-desktop.png'),fullPage:true});
  await page.click('#fineExport');const fine=await waitJob();check('actual fine export trims exactly two frames',fine.media.frameCount===1534&&fine.qaPassed);
  await page.waitForSelector('#fineOutputs [data-output]');await page.click('#fineOutputs [data-output]');await page.waitForFunction(()=>document.getElementById('fineVideo').readyState>=2);await page.$eval('#fineVideo',v=>v.pause());
  await page.click('.workflow [data-stage="visual"]');await page.waitForFunction(()=>document.body.dataset.stage==='visual');await page.click('#visualBind');await page.waitForSelector('[data-cue="1"]');await page.click('[data-cue="1"]');
  await change('#visualItems input[type="number"]:first-child',1); // query below fixes the explicit end field
  const end=await page.$$('#visualItems .frame-inputs input');await end[1].evaluate(n=>{n.value=120;n.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.click('#visualSave');await page.waitForFunction(()=>document.getElementById('visualStatus').textContent.includes('r1'));
  await change('#motionLeft','资金');await change('#motionRight','家庭责任');await page.click('#motionCreate');const motion=await waitJob();check('existing directed motion builder and HyperFrames render real 4-second asset',motion.asset.kind==='video'&&motion.asset.duration>=3.99);
  const assetSelect='#visualItems .frame-inputs select:first-child';await page.waitForSelector(`option[value="${motion.asset.id}"]`);await page.select(assetSelect,motion.asset.id);await page.click('#visualSave');await page.waitForFunction(()=>document.getElementById('visualStatus').textContent.includes('r2'));await page.waitForSelector('#visualLayers video');await page.waitForFunction(()=>document.querySelector('#visualLayers video').readyState>=2);
  await page.$eval('#visualVideo',v=>{v.currentTime=1.8;});await new Promise(r=>setTimeout(r,500));
  check('MG overlay follows fine timeline with muted asset',await page.$eval('#visualLayers video',v=>v.muted&&Math.abs(v.currentTime-1.8)<.2));
  await page.screenshot({path:join(out,'02-visual-motion-desktop.png'),fullPage:true});
  // Add a second, unfulfilled image task to verify the actual Codex packet route.
  await page.click('[data-cue="2"]');await page.click('#visualSave');await page.waitForFunction(()=>document.getElementById('visualStatus').textContent.includes('r3'));await page.click('#taskDetails summary');await page.click('#taskCreate');await page.waitForFunction(()=>document.getElementById('taskResult').textContent.includes('task.json'));
  const state=await page.evaluate(async()=>await(await fetch('/api/stages')).json()),tasks=state.visual.items.filter(i=>!i.assetId);
  check('missing illustration creates a bound executable task packet',tasks.length===1);
  const screenshot=join(out,'import-image.png');await native('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=0x84bea9:size=640x360','-frames:v','1',screenshot]);
  const taskFile=await page.$eval('#taskResult',n=>n.textContent.split('\n')[1]),task=JSON.parse(await readFile(taskFile,'utf8')),results=join(out,'results.json');
  await writeFile(results,JSON.stringify({kind:'local-visual-asset-results',taskId:task.id,bindingId:task.binding.id,results:[{itemId:tasks[0].id,path:screenshot}]}));
  await change('#resultsPath',results);await page.click('#resultsImport');await page.waitForFunction(()=>document.getElementById('visualStatus').textContent.includes('r4'));
  await page.click('#visualExport');const visual=await waitJob();check('final composition is a real playable MP4 on the same fine clock',visual.media.frameCount===1534&&visual.qaPassed);
  const qa=JSON.parse(await readFile(join(visual.outputDir,'qa.json'),'utf8'));check('final AAC payload stays identical to fine original audio',qa.checks.audioPayloadUnchanged);
  await page.waitForSelector('#visualOutputs [data-output]');await page.click('#visualOutputs [data-output]');await page.waitForFunction(()=>{const v=document.getElementById('visualVideo');return v.currentTime>1.4&&v.getVideoPlaybackQuality().totalVideoFrames>=30;});check('actual composite continuously plays through the bound output link',await page.$eval('#visualVideo',v=>!v.paused&&v.src.includes('/visual/')));await page.$eval('#visualVideo',async v=>{v.pause();await new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=1.8;});});await page.evaluate(()=>document.querySelectorAll('.stage-monitor,.stage-editor').forEach(n=>n.scrollTop=0));await new Promise(r=>setTimeout(r,250));
  await page.screenshot({path:join(out,'03-actual-composite.png'),fullPage:true});
  check('actual export suppresses duplicate overlay/caption preview',await page.$eval('#visualCaption',n=>!n.textContent)&&await page.$$eval('.visual-layer',nodes=>nodes.every(n=>n.hidden)));
  await page.setViewport({width:820,height:1100});await page.screenshot({path:join(out,'04-visual-narrow.png'),fullPage:true});check('visual panel has no narrow horizontal overflow',await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
  await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.body.dataset.stage==='rough');await page.click('.workflow [data-stage="fine"]');await page.waitForFunction(()=>document.body.dataset.stage==='fine');await page.waitForSelector('[data-clip="0"]');check('fine selection survives reload',await page.$eval('[data-clip="0"][data-boundary="endFrameExclusive"]',(n,expected)=>Number(n.value)===expected,left-1));
  check('zero browser errors',errors.length===0);check('zero external browser requests',external.length===0);
  for(const [label,time]of [['before',.2],['during',1.8],['after',3.8]])await native('ffmpeg',['-nostdin','-v','error','-n','-ss',String(time),'-i',motion.asset.sourcePath,'-frames:v','1',join(out,'motion-'+label+'.png')]);
  check('actual MG changes across before/middle/after frames',new Set(await Promise.all(['before','during','after'].map(s=>hashFile(join(out,'motion-'+s+'.png'))))).size===3);
  const report={kind:'local-stages-browser-qa',passed:true,checks,errors,external,projectDir:dir,fine,visual,motion,userApprovalRecorded:false,creativeAcceptanceCompleted:false};await writeFile(join(out,'qa.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({passed:true,checks:checks.length,out,projectDir:dir,fine:fine.outputDir,visual:visual.outputDir,motion:motion.sourceDir}));
}catch(e){await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(out,'failure.json'),JSON.stringify({error:e.message,errors,external,ui:await page.evaluate(()=>({message:document.getElementById('message').textContent,fineStatus:document.getElementById('fineStatus').textContent,visualStatus:document.getElementById('visualStatus').textContent,taskResult:document.getElementById('taskResult').textContent}))},null,2));throw e;}finally{await browser.close();await new Promise(r=>service.server.close(r));}
