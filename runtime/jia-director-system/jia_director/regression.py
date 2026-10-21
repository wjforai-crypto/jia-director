from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path

from .core import read_json,write_json,new_dir,binding
from .clip import render

TEXT_KEYS={'text','sub','label','title','caption','key','source','unit'}

def map_text(obj,fn,key=None):
    if isinstance(obj,dict):return {k:map_text(v,fn,k) for k,v in obj.items()}
    if isinstance(obj,list):return [map_text(v,fn,key) for v in obj]
    return fn(obj) if isinstance(obj,str) and key in TEXT_KEYS else obj

def variants(spec):
    result={'base':copy.deepcopy(spec)}
    portrait=copy.deepcopy(spec);portrait.update(width=540,height=960);result['portrait']=portrait
    square=copy.deepcopy(spec);square.update(width=720,height=720);result['square']=square
    result['long']=map_text(copy.deepcopy(spec),lambda s:s+'，这里增加一段较长中文，检查自动换行与安全避让')
    counter=[0]
    def english(s):
        counter[0]+=1
        return ['Show the evidence clearly','Keep the same object moving','A readable result stays on screen','Follow the change over time'][counter[0]%4]
    result['english']=map_text(copy.deepcopy(spec),english)
    return result

def regression(spec_files,output,*,workers=2,full=False):
    out=new_dir(output);jobs=[]
    for spec_path in spec_files:
        spec_path=Path(spec_path).resolve();base=read_json(spec_path)
        for variant,spec in variants(base).items():
            p=out/'inputs'/spec_path.stem/(variant+'.json');write_json(p,spec)
            jobs.append((spec_path.stem,variant,p))
    report={'kind':'jia-visual-regression','status':'running','jobs':[],'scope':'eight grammar fixtures and all declared variants; actual draw audit is sampled every 0.25 seconds','humanReviewed':False}
    write_json(out/'regression.json',report)
    def one(job):
        name,variant,p=job;jobdir=out/'jobs'/name/variant
        result={'grammar':name,'variant':variant,'input':binding(p),'status':'failed'}
        try:
            audit=render(p,jobdir/'audit',audit=True)
            result['layout']=binding(jobdir/'audit/layout-upstream.json')
            result['layoutStatus']=audit['status']
            s=read_json(p)
            still=render(p,jobdir/'stills',stills=[0.0,round(s['duration']*0.5,3),round(s['duration']-1/s['fps'],4)])
            result['frames']=still['frames']
            if full and variant=='base':
                media=render(p,jobdir/'video')
                result['media']=media['media']
            result['status']='passed' if audit['status']=='passed' else 'layout-failed'
        except Exception as e:result['error']=str(e)
        return result
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures=[pool.submit(one,j) for j in jobs]
        for f in as_completed(futures):
            value=f.result();report['jobs'].append(value)
            write_json(out/'regression.json',report)
            print(value['grammar'],value['variant'],value['status'],flush=True)
    report['jobs'].sort(key=lambda x:(x['grammar'],x['variant']))
    report['passed']=sum(x['status']=='passed' for x in report['jobs']);report['total']=len(jobs)
    report['status']='passed' if report['passed']==len(jobs) else 'failed'
    write_json(out/'regression.json',report)
    return report
