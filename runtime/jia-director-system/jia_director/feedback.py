"""Append-only, version-bound repair records. No automatic change to user approvals."""
from pathlib import Path
import datetime

from .core import read_json,write_json,binding,verify_nested_bindings,new_dir

def record_repair(input_path,output):
    value=read_json(input_path)
    if not isinstance(value,dict) or not all(isinstance(value.get(k),str) and value[k].strip() for k in ('issue','cause','fix','destination')):raise ValueError('Repair requires issue/cause/fix/destination')
    if value['destination'] not in ('project','recipe','skill-candidate'):raise ValueError('Destination is project, recipe or skill-candidate; never auto-promote')
    if not isinstance(value.get('evidence'),list) or not value['evidence']:raise ValueError('Actual evidence paths required')
    reports=[read_json(p) for p in value['evidence']]
    allowed={'jia-director-clip','jia-scene-render','jia-continuous-qa','jia-final-qa','jia-parent-composition','jia-storyboard-preflight','jia-visual-regression','jia-repair-verification'}
    if any(r.get('kind') not in allowed or r.get('status')!='passed' for r in reports):raise ValueError('Repair requires a supported passed retest report')
    def bindings(obj):
        if isinstance(obj,dict):
            if 'path' in obj and 'sha256' in obj:yield obj
            for v in obj.values():yield from bindings(v)
        elif isinstance(obj,list):
            for v in obj:yield from bindings(v)
    if any(not list(bindings(r)) for r in reports):raise ValueError('Retest lacks actual version/asset bindings')
    if not isinstance(value.get('affected'),dict) or not all(value['affected'].get(k) for k in ('path','sha256')):raise ValueError('Affected repaired file/version binding required')
    verify_nested_bindings(value['affected'])
    if not any(b['path']==value['affected']['path'] and b['sha256']==value['affected']['sha256'] for r in reports for b in bindings(r)):raise ValueError('Retest does not cover this affected version')
    for r in reports:verify_nested_bindings(r)
    out=new_dir(output)
    result={**value,'kind':'jia-repair-record','status':'passed','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'input':binding(input_path),'retest':[binding(p) for p in value['evidence']],'promotion':'candidate-only','userAccepted':False}
    write_json(out/'repair.json',result)
    return result
