from __future__ import annotations

import copy
import json
from pathlib import Path
import sys

from .core import ROOT,RUNTIME,ENGINE,read_json,write_json,run,binding,directory_binding,verify_nested_bindings,source_binding,new_dir,media_probe,finite_number

def field(obj, dotted):
    for part in dotted.split('.'):
        if not isinstance(obj,dict) or part not in obj:
            return None
        obj=obj[part]
    return obj

def validate_spec(spec, base):
    schema=read_json(ENGINE/'clip_schema.json')
    if not isinstance(spec,dict):
        raise ValueError('Spec must be an object')
    unknown=set(spec)-set(schema['common']['spec'])
    if unknown:
        raise ValueError('Unknown spec fields: '+', '.join(sorted(unknown)))
    g=spec.get('grammar')
    if g not in schema['grammars']:
        raise ValueError('Unknown grammar: '+str(g))
    rules=schema['grammars'][g]
    s=copy.deepcopy(spec)
    for key,default in [('width',1920),('height',1080),('fps',30)]:
        value=s.setdefault(key,default)
        if isinstance(value,bool) or not isinstance(value,int) or value<=0 or (key!='fps' and value%2):
            raise ValueError(key+' must be a positive even integer (fps: positive integer)')
    finite_number(s.get('duration'),'duration',0.001)
    if round(s['duration']*s['fps'])<1:raise ValueError('Duration must produce at least one output frame')
    if s['duration']>8:
        raise ValueError('Adopted rule H10: parameterized clip duration must be <=8 seconds')
    if s['width']>7680 or s['height']>7680 or s['fps']>120:
        raise ValueError('Spec exceeds supported rendering bounds')
    if not isinstance(s.get('cues'),list) or not s['cues']:
        raise ValueError('Nonempty cues array required')
    if not isinstance(s.get('data',{}),dict):
        raise ValueError('data must be an object')
    bad=set(s.get('data',{}))-set(rules['specData'])
    if bad:
        raise ValueError('Unknown grammar data fields: '+', '.join(sorted(bad)))
    for need in rules.get('specNeeds',[]):
        if field(s,need) in (None,[],{},''):
            raise ValueError('Required '+need)
    if g=='t3_finance_chart':
        series=s['data'].get('series')
        if not isinstance(series,list) or not series:
            raise ValueError('Chart series must be a nonempty list')
        for i,row in enumerate(series):
            if not isinstance(row,dict) or not isinstance(row.get('label'),str):
                raise ValueError('Chart rows require labels')
            keys=('open','high','low','close') if s['data'].get('chart')=='candle' else ('value',)
            for k in keys:finite_number(row.get(k),f'series[{i}].{k}',float('-inf'))
    for i,q in enumerate(s['cues']):
        if not isinstance(q,dict):
            raise ValueError('cue must be an object')
        bad=set(q)-set(schema['common']['cue'])
        if bad:
            raise ValueError('Unknown cue fields: '+', '.join(sorted(bad)))
        at=finite_number(q.get('at'),f'cue[{i}].at')
        if at>=s['duration']:
            raise ValueError('cue must occur before clip end')
        if q.get('kind') not in rules['kinds']:
            raise ValueError('Unknown cue kind: '+str(q.get('kind')))
        if not isinstance(q.get('data',{}),dict):
            raise ValueError('cue.data must be an object')
        bad=set(q.get('data',{}))-set(rules['cueData'])
        if bad:
            raise ValueError('Unknown cue data fields: '+', '.join(sorted(bad)))
        for need in rules.get('needs',{}).get(q['kind'],[]):
            if not any(field(q,k) not in (None,[],{},'') for k in need.split('|')):
                raise ValueError('Required cue field '+need)
    def local_assets(obj,key=None):
        if isinstance(obj,dict):
            for k,v in obj.items():
                if k=='frames' and isinstance(v,dict):
                    for name,value in v.items():
                        v[name]=asset(value)
                elif k in ('image','frames') and isinstance(v,str):
                    obj[k]=asset(v,directory=k=='frames')
                elif k=='frames' and isinstance(v,list):
                    if not v:raise ValueError('Frame sequence cannot be empty')
                    obj[k]=[asset(x) for x in v]
                elif k=='character' and isinstance(v,str):
                    if v in ('neutral','bun','author'):
                        raise ValueError('Character presets are disabled; provide actual character assets')
                    obj[k]=asset(v,directory=True)
                else:
                    local_assets(v,k)
        elif isinstance(obj,list):
            for v in obj:
                local_assets(v)
    def asset(value,directory=False):
        if not isinstance(value,str) or value.startswith(('http:','https:','data:','file:')):
            raise ValueError('Asset must be an explicitly existing local file/directory')
        p=(Path(base)/value).resolve()
        if not p.exists():
            raise ValueError('Missing asset: '+str(p))
        if directory:
            if not p.is_dir() or not directory_binding(p)['files']:raise ValueError('Frames require a nonempty image directory')
        elif not p.is_file():raise ValueError('Image asset must be a file')
        return str(p)
    local_assets(s)
    return s

def render(spec_path, output, *, stills=None, alpha=False, audit=False):
    spec_path=Path(spec_path).resolve()
    spec=validate_spec(read_json(spec_path),spec_path.parent)
    if alpha:
        spec['alpha']=True
    out=new_dir(output)
    normalized=out/'spec.json'
    write_json(normalized,spec)
    source=source_binding()
    target=out/('clip.mov' if alpha else 'clip.mp4')
    cmd=[sys.executable,'-X','utf8',str(ENGINE/'render.py'),'--spec',str(normalized),'--out',str(target)]
    if stills is not None:
        cmd[-1]=str(out/'frames')
        cmd+=['--stills',','.join(str(x) for x in stills)]
    if alpha:
        cmd+=['--alpha']
    if audit:
        cmd+=['--audit',str(out/'layout-upstream.json')]
    asset_files=[]
    def collect_assets(obj,key=None):
        if isinstance(obj,dict):
            for k,v in obj.items():collect_assets(v,k)
        elif isinstance(obj,list):
            for v in obj:collect_assets(v,key)
        elif isinstance(obj,str):
            try:
                if Path(obj).is_file():asset_files.append(binding(obj))
                elif Path(obj).is_dir():asset_files.append(directory_binding(obj))
            except OSError:pass
    collect_assets(spec)
    receipt={'kind':'jia-director-clip','input':binding(spec_path),'source':source,'assets':asset_files,'normalizedSpec':binding(normalized),'status':'running','userAccepted':False}
    receipt['reportPath']=str(out/'receipt.json')
    write_json(out/'receipt.json',receipt)
    try:
        result=run(cmd,timeout=1800,ok=(0,1) if audit else (0,),log=out/'command.json')
        if audit:
            receipt['layoutExitCode']=result['exitCode']
            receipt['status']='passed' if result['exitCode']==0 else 'failed'
        elif stills is not None:
            images=sorted((out/'frames').glob('*.png'))
            if len(images)!=len(stills):
                raise ValueError('Requested still frames missing')
            receipt['frames']=[binding(x) for x in images]
            receipt['status']='passed'
        else:
            receipt['media']=media_probe(target,expected=spec)
            if alpha and receipt['media']['pixFmt'] not in ('yuva444p10le','yuva444p12le'):
                raise ValueError('Transparent output has no alpha pixel format')
            receipt['status']='passed'
    except Exception as e:
        receipt['status']='failed';receipt['error']=str(e)
        write_json(out/'receipt.json',receipt)
        raise
    verify_nested_bindings({'input':receipt['input'],'source':receipt['source'],'assets':receipt['assets'],'normalizedSpec':receipt['normalizedSpec']})
    write_json(out/'receipt.json',receipt)
    return receipt

def qa(spec_path,output):
    path=Path(spec_path).resolve()
    spec=validate_spec(read_json(path),path.parent)
    out=new_dir(output)
    write_json(out/'spec.json',spec)
    source=source_binding()
    command=run([sys.executable,'-X','utf8',RUNTIME/'qa.py','--spec',out/'spec.json','--out',out/'upstream'],ok=(0,1),timeout=1800,log=out/'command.json')
    raw=read_json(out/'upstream/qa.json')
    errors=[]
    if raw.get('page_errors'):errors.append('Browser runtime errors')
    if any(not s.get('deterministic') for s in raw['segments']):errors.append('Non-deterministic time-based rendering')
    if any(s.get('framing') for s in raw['segments']):errors.append('Persistent text/blank framing issues need repair')
    if command['exitCode']:errors.append('Upstream QA process failed')
    verify_nested_bindings(source)
    result={'kind':'jia-continuous-qa','status':'failed' if errors else 'passed','errors':errors,'input':binding(path),'normalizedSpec':binding(out/'spec.json'),'source':source,'upstream':raw,'reportPath':str(out/'qa.json')}
    write_json(out/'qa.json',result)
    return result
