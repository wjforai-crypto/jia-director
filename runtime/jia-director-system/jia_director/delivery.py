from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys

from .core import ROOT,RUNTIME,binding,read_json,write_json,verify_binding,verify_nested_bindings,media_probe,run,source_binding,new_dir,sha256,finite_number

def inspect_final(video,output,*,spec=None,production_receipt=None,allow_blue_purple=None):
    video=Path(video).resolve();out=new_dir(output)
    media=media_probe(video,expected=read_json(spec) if spec else None)
    cmd=[sys.executable,'-X','utf8',RUNTIME/'film_gate.py',video,'--json','--no-template']
    if allow_blue_purple:cmd+=['--allow-blue-purple',allow_blue_purple]
    raw=run(cmd,ok=(0,2),timeout=600,log=out/'film-gate.command.json')
    metrics=json.loads(raw['stdout']);write_json(out/'film-gate.json',metrics)
    errors=[];warnings=[]
    fast=float(metrics['fast_ratio']);blue=float(metrics['blue_purple_share']);blank=float(metrics['blank_run_s'])
    # Apply the explicitly adopted thresholds even when upstream exempts a very short test clip.
    if fast<0.035:errors.append('H12 fast motion ratio below 0.035')
    elif fast<0.06:warnings.append('H12 fast motion ratio below 0.06')
    if blank>=0.3:errors.append('Continuous empty content exceeds 0.3 seconds')
    if blue>=0.30:
        (warnings if allow_blue_purple else errors).append('H01 blue-purple share at least 30%'+(': '+allow_blue_purple if allow_blue_purple else ''))
    elif blue>=0.12:warnings.append('Blue-purple share at least 12%; review scene')
    inputs=[]
    if spec:inputs.append(binding(spec))
    if production_receipt:
        production=read_json(production_receipt)
        if production.get('status')!='passed' or production.get('media',{}).get('file',{}).get('sha256')!=sha256(video):raise ValueError('Production receipt does not match this video')
        verify_nested_bindings(production)
        inputs.append(binding(production_receipt))
        # Bind the concrete spec, assets and original timeline, not just a receipt file name.
        def gather(obj):
            if isinstance(obj,dict):
                if 'path' in obj and 'sha256' in obj:inputs.append(obj)
                for v in obj.values():gather(v)
            elif isinstance(obj,list):
                for v in obj:gather(v)
        gather(production)
    else:
        errors.append('Production receipt required before delivery; standalone inspection only')
    result={'kind':'jia-final-qa','status':'failed' if errors else 'passed','media':media,'source':source_binding(),'inputs':inputs,'algorithm':binding(RUNTIME/'film_gate.py'),'filmGate':binding(out/'film-gate.json'),'errors':errors,'warnings':warnings,'allowBluePurpleReason':allow_blue_purple,'userAccepted':False,'subjectiveVisualReviewed':False,'subjectiveAudioReviewed':False,'reportPath':str(out/'qa.json')}
    write_json(out/'qa.json',result)
    return result

def validate_delivery(video,qa_path,review_path):
    qa=read_json(qa_path);review=read_json(review_path)
    if qa.get('kind')!='jia-final-qa' or qa.get('status')!='passed':raise ValueError('Final QA has not passed')
    verify_binding(qa['media']['file'])
    if Path(qa['media']['file']['path']).resolve()!=Path(video).resolve():raise ValueError('QA belongs to another video')
    for b in qa['source']['files']:verify_binding(b)
    for b in qa.get('inputs',[]):verify_binding(b)
    verify_binding(qa['algorithm']);verify_binding(qa['filmGate'])
    if not review.get('reviewer') or review.get('status')!='passed':raise ValueError('Independent review has not passed')
    if review.get('kind')!='independent-review':raise ValueError('Independent review kind required')
    if not isinstance(review.get('coverage'),list) or not review['coverage']:raise ValueError('Review coverage required')
    for interval in review['coverage']:
        if not isinstance(interval,dict) or not isinstance(interval.get('mode'),str) or not interval['mode'].strip():raise ValueError('Concrete review mode required')
        a=finite_number(interval.get('from'),'coverage.from');b=finite_number(interval.get('to'),'coverage.to')
        if b<=a or b>qa['media'].get('duration',b)+0.05:raise ValueError('Review coverage outside video')
    if review.get('findings') and any(x.get('status')!='resolved' for x in review['findings']):raise ValueError('Review has unresolved findings')
    for finding in review.get('findings',[]):
        if not all(finding.get(k) for k in ('issue','cause','fix','retest','destination')):raise ValueError('Resolved findings require issue/cause/fix/retest/destination')
        verify_nested_bindings(finding['retest'])
    if review.get('videoSha256')!=sha256(video):raise ValueError('Review belongs to stale video')
    if review.get('qaSha256')!=sha256(qa_path):raise ValueError('Review belongs to stale QA')
    if review.get('sourceSha256')!=qa['source']['sha256']:raise ValueError('Review belongs to another source revision')
    if review.get('userAccepted') is True:raise ValueError('Agent review cannot grant Wang Jie final acceptance')
    if qa['warnings']:
        decisions=review.get('warningDecisions',[])
        if not isinstance(decisions,list) or len(decisions)!=len(qa['warnings']) or any(not isinstance(x,dict) or x.get('warning')!=w or not isinstance(x.get('reason'),str) or not x['reason'].strip() for x,w in zip(decisions,qa['warnings'])):raise ValueError('Yellow-light reasons need actual review decisions for every warning')
    return qa,review

def deliver(video,qa_path,review_path,output):
    qa,review=validate_delivery(video,qa_path,review_path)
    out=new_dir(output)
    target=out/Path(video).name;shutil.copyfile(video,target)
    shutil.copyfile(qa_path,out/'qa.json');shutil.copyfile(review_path,out/'review.json')
    shutil.copyfile(qa['filmGate']['path'],out/'film-gate.json')
    shutil.copyfile(qa['algorithm']['path'],out/'film-gate.py')
    frozen={'kind':'jia-frozen-delivery','version':'2.0.0','status':'technical-and-independent-review-passed','userAccepted':False,'published':False,'artifacts':[binding(target),binding(out/'qa.json'),binding(out/'review.json'),binding(out/'film-gate.json'),binding(out/'film-gate.py')],'source':qa['source'],'inputs':qa.get('inputs',[])+[qa['filmGate'],qa['algorithm']],'upstream':binding(ROOT/'vendor/upstream-lock.json')}
    write_json(out/'manifest.json',frozen)
    (out/'交付说明.md').write_text(f"# 待王杰审片\n\n实际视频：{target.name}\n\n技术检查与独立审核对应同一视频、源码和QA版本；黄灯解释见review.json。本人接受与发布仍为false。修改任一绑定文件后必须重新验证和审核。\n",encoding='utf-8')
    return {'status':'delivered-pending-user','manifest':str(out/'manifest.json'),'video':str(target),'userAccepted':False}

def verify_delivery(manifest_path):
    manifest=read_json(manifest_path)
    if manifest.get('kind')!='jia-frozen-delivery':raise ValueError('Unexpected manifest kind')
    for b in manifest['artifacts']+manifest['source']['files']+manifest.get('inputs',[])+[manifest['upstream']]:verify_binding(b)
    for b in manifest['artifacts']:
        if Path(b['path']).name in ('qa.json','review.json'):verify_nested_bindings(read_json(b['path']))
    return {'status':'verified','manifest':str(Path(manifest_path).resolve()),'userAccepted':manifest.get('userAccepted',False)}
