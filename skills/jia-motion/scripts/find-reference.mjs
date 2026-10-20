import fs from 'node:fs/promises';
const args=process.argv.slice(2),options={};
try{
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('find-reference.mjs --query WORDS [--index LOCAL_JSON] [--limit 1..20]');process.exit(0);}
    if(!['--query','--index','--limit'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(options,args[i].slice(2)))throw new Error('Invalid query/index/limit arguments');
    options[args[i].slice(2)]=args[++i];
  }
  if(!options.query?.trim())throw new Error('--query is required');
  const limit=Number(options.limit??6);if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('limit must be 1..20');
  const index=options.index??'E:/视频文档/导演系统资料库/2026-10-17/案例索引.json',data=JSON.parse(await fs.readFile(index,'utf8'));
  const groups=[['ui','界面','button','morph','按钮'],['pixel','像素','wizard','巫师'],['hand','手绘','character','角色','clawd'],['3d','three','三维','space','空间'],['history','历史','battle','战役']];
  const tokens=options.query.toLowerCase().split(/\s+/),expanded=new Set(tokens);
  for(const group of groups)if(tokens.some(t=>group.includes(t)))group.forEach(t=>expanded.add(t));
  const matches=(text,term)=>/^[a-z0-9]+$/i.test(term)
    ?new RegExp('(^|[^a-z0-9])'+term+'(?=$|[^a-z0-9])','i').test(text)
    :text.includes(term);
  const results=data.records.map(r=>{const text=(r.title+' '+r.author+' '+r.sources.map(s=>s.file).join(' ')).toLowerCase();return {...r,matchHints:[...expanded].filter(t=>matches(text,t))};})
    .filter(r=>r.matchHints.length).sort((a,b)=>b.matchHints.length-a.matchHints.length).slice(0,limit);
  console.log(JSON.stringify({query:options.query,index,totalOrigins:data.count,results,notice:'Metadata hints only. Open the original post and verify the video, rights and implementation before use.'},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
