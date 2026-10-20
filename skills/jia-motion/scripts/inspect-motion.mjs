import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sha=b=>createHash('sha256').update(b).digest('hex');
function args(argv){const a={};for(let i=0;i<argv.length;i++){if(argv[i]==='--help')return{help:true};if(!['--project','--output','--playwright','--browser'].includes(argv[i])||!argv[i+1]||argv[i+1].startsWith('--')||Object.hasOwn(a,argv[i].slice(2)))throw new Error('Need distinct --project, --output, --playwright and --browser');a[argv[i].slice(2)]=argv[++i];}return a;}
const within=(root,p)=>{const r=path.relative(root,p);return !r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
async function main(){
  const a=args(process.argv.slice(2));if(a.help){console.log('inspect-motion.mjs --project EXISTING_DIR --output NEW_QA_DIR --playwright INSTALLED_PACKAGE --browser EXISTING_CHROMIUM');return;}
  for(const k of ['project','output','playwright','browser'])if(!a[k])throw new Error(`--${k} is required`);
  const root=await fs.realpath(a.project),output=path.resolve(a.output),spec=JSON.parse(await fs.readFile(path.join(root,'scene.json'),'utf8'));
  await fs.access(a.browser);let present=false;try{await fs.lstat(output);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(present)throw new Error(`Output already exists: ${output}`);
  const {chromium}=require(path.resolve(a.playwright));
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);
  const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.ttc':'font/collection','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2'};
  const server=http.createServer(async(req,res)=>{try{
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    const local=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!within(root,local)){res.writeHead(403);res.end();return;}
    const real=await fs.realpath(local);if(!within(root,real)){res.writeHead(403);res.end();return;}
    const body=await fs.readFile(real);res.writeHead(200,{'Content-Type':mime[path.extname(real)]??'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  }catch(e){res.writeHead(e.code==='ENOENT'?404:500);res.end('Local resource unavailable');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;const errors=[],blocked=[];
  const report={schemaVersion:1,project:root,canvas:spec,audio:'none',technicalVerified:false,userAccepted:false,subjectiveListeningPerformed:false,screenshots:[],errors,blockedExternalRequests:blocked};
  try{
    browser=await chromium.launch({headless:true,executablePath:path.resolve(a.browser)});
    const page=await browser.newPage({viewport:{width:spec.width,height:spec.height},deviceScaleFactor:1});
    const origin=`http://127.0.0.1:${server.address().port}`;
    page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.route('**/*',route=>{const u=route.request().url();if(u.startsWith(origin+'/')||u.startsWith('data:'))return route.continue();blocked.push(u);return route.abort();});
    await page.goto(origin+'/index.html');await page.waitForFunction(()=>window.__jiaMotion?.ready===true);await page.evaluate(()=>document.fonts.ready);
    report.fontReady=await page.evaluate(()=>document.fonts.check('20px MotionLocal'));
    const times=[0,.15,.25,.39,.48,.58,.7,.86,.98].map(p=>Math.floor(p*spec.duration*spec.fps)/spec.fps);
    for(let i=0;i<times.length;i++){
      const t=times[i];await page.evaluate(t=>window.__jiaMotion.seek(t),t);
      const file=`frame-${String(i).padStart(2,'0')}.png`,bytes=await page.screenshot({path:path.join(output,file)});
      report.screenshots.push({time:t,file,sha256:sha(bytes),state:await page.evaluate(t=>window.__jiaMotion.stateAt(t),t)});
    }
    const probe=Math.floor(.31*spec.duration*spec.fps)/spec.fps;
    await page.evaluate(t=>window.__jiaMotion.seek(t),probe);const before=sha(await page.screenshot());
    for(const t of [spec.duration*.94,.03,spec.duration*.63])await page.evaluate(t=>window.__jiaMotion.seek(t),t);
    // GSAP timelines are thenables. Return no timeline from evaluate: a paused
    // timeline returned here would wait forever for its completion promise.
    await page.evaluate(t=>{window.__timelines[window.__jiaMotion.id].totalTime(t,true);},probe);
    const after=sha(await page.screenshot());report.randomSeek={time:probe,before,after,passed:before===after,suppressedGsapCallbacksChecked:true};
    report.dom=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id),duplicates=ids.filter((id,i)=>ids.indexOf(id)!==i);return{duplicates,subjectCount:document.querySelectorAll('#hero-shell,#hero-core').length};});
    report.timeline=await page.evaluate(()=>({id:window.__jiaMotion.id,duration:window.__timelines[window.__jiaMotion.id].duration()}));
    report.technicalVerified=report.fontReady&&report.randomSeek.passed&&report.dom.duplicates.length===0&&report.dom.subjectCount===1&&errors.length===0&&blocked.length===0&&Math.abs(report.timeline.duration-spec.duration)<1e-6;
    report.scope='Local source rendering, font load, persistent subject identity, repeatable reverse/suppressed-event seek. Final MP4, continuous-play judgment, style quality and user acceptance remain separate.';
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({technicalVerified:report.technicalVerified,output,samples:times.length,randomSeek:report.randomSeek.passed,errors}));
    if(!report.technicalVerified)process.exitCode=1;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e.stack??e.message);process.exitCode=1;});
