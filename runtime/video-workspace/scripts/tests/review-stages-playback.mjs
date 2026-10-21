// Read-only follow-up: inspect real exported playback and both responsive pages.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { serveReview, native } from '../rough-review.mjs';
const root=resolve('.'),dir=resolve(process.argv[2]);
const cfg=JSON.parse(await readFile(join(root,'config/video-workflow.json'),'utf8')),require=createRequire(pathToFileURL(join(root,'runtime/hyperframes/package.json'))),puppeteer=require('puppeteer-core');
const out=join(root,'checks/2026-10-10/stage-continuation','playback-'+randomUUID());await mkdir(out,{recursive:true});
const service=await serveReview(dir),browser=await puppeteer.launch({executablePath:cfg.render.browserPath,headless:true,args:['--autoplay-policy=no-user-gesture-required'],defaultViewport:{width:1440,height:1000}}),page=await browser.newPage(),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(service.url)&&!r.url().startsWith('data:'))external.push(r.url());});
try{
 await page.goto(service.url,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.body.dataset.stage==='rough');
 await page.click('[data-stage="visual"]');await page.waitForFunction(()=>document.body.dataset.stage==='visual');await page.waitForSelector('#visualOutputs [data-output]',{visible:true});await page.click('#visualOutputs [data-output]');
 await page.waitForFunction(()=>{const v=document.getElementById('visualVideo');return v.currentTime>1.4&&v.getVideoPlaybackQuality().totalVideoFrames>=30;});
 const playback=await page.$eval('#visualVideo',v=>({seconds:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,ready:v.readyState,paused:v.paused}));
 await page.$eval('#visualVideo',async v=>{v.pause();await new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=1.8;});});
 await page.evaluate(()=>{document.querySelectorAll('.stage-monitor,.stage-editor').forEach(n=>n.scrollTop=0);window.scrollTo(0,0);});await new Promise(r=>setTimeout(r,250));
 await page.screenshot({path:join(out,'visual-desktop.png'),fullPage:true});
 assert.equal(await page.$eval('#message',n=>n.textContent.includes('interrupted')),false);
 const state=await page.evaluate(async()=>await(await fetch('/api/stages')).json()),id=state.exports.visual[0].id;
 const video=join(dir,'stages/visual-exports',id,'visual.mp4');
 for(const [label,time]of [['during',1.8],['after',4.5]])await native('ffmpeg',['-nostdin','-v','error','-n','-ss',String(time),'-i',video,'-frames:v','1',join(out,'final-'+label+'.png')]);
 await page.setViewport({width:820,height:1100});await page.screenshot({path:join(out,'visual-narrow.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
 await page.setViewport({width:1440,height:1000});await page.click('[data-stage="fine"]');await page.waitForFunction(()=>document.body.dataset.stage==='fine');await page.screenshot({path:join(out,'fine-desktop.png'),fullPage:true});
 await page.setViewport({width:820,height:1100});await page.screenshot({path:join(out,'fine-narrow.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(join(out,'qa.json'),JSON.stringify({passed:true,playback,errors,external,subjectiveListeningCompleted:false,creativeAcceptanceCompleted:false,userApprovalRecorded:false,projectDir:dir},null,2));
 process.stdout.write(JSON.stringify({passed:true,out,playback}));
}catch(e){await page.screenshot({path:join(out,'failure.png'),fullPage:true});await writeFile(join(out,'failure.json'),JSON.stringify({error:e.message,errors,external,video:await page.$eval('#visualVideo',v=>({time:v.currentTime,paused:v.paused,ready:v.readyState,network:v.networkState,src:v.src,error:v.error?.message,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),quality:v.getVideoPlaybackQuality().toJSON?.()})),message:await page.$eval('#message',n=>n.textContent)},null,2));throw e;}finally{await browser.close();await new Promise(r=>service.server.close(r));}
