from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime/huashu'
ENGINE = RUNTIME / 'engine'
CONFIG_PATH = Path(os.environ.get('JIA_VIDEO_CONFIG', ROOT.parent / 'video-workspace/config/video-workflow.json'))

def read_json(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))

def write_json(p, value):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')

def sha256(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def binding(p):
    p = Path(p).resolve()
    return {'path': str(p), 'sha256': sha256(p), 'bytes': p.stat().st_size}

def verify_binding(b):
    p = Path(b['path'])
    if b.get('kind')=='frame-directory':
        if not p.is_dir() or directory_binding(p)['sha256']!=b['sha256']:
            raise ValueError(f'Stale or changed frame directory: {p}')
        return
    if not p.is_file() or sha256(p) != b['sha256']:
        raise ValueError(f'Stale or changed evidence: {p}')

def directory_binding(p):
    p=Path(p).resolve()
    files=[binding(f) for f in sorted(p.iterdir()) if f.is_file() and f.suffix.lower() in ('.png','.jpg','.jpeg','.webp')]
    digest=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
    return {'kind':'frame-directory','path':str(p),'sha256':digest,'files':files}

def verify_nested_bindings(value):
    if isinstance(value,dict):
        if isinstance(value.get('path'),str) and isinstance(value.get('sha256'),str):verify_binding(value)
        for v in value.values():verify_nested_bindings(v)
    elif isinstance(value,list):
        for v in value:verify_nested_bindings(v)

def config():
    return read_json(CONFIG_PATH)

def tool(name):
    return config().get('tools', {}).get(name + 'Command', name)

def run(args, *, timeout=300, ok=(0,), cwd=None, log=None):
    env = os.environ.copy()
    env.update({'PYTHONUTF8':'1','PYTHONIOENCODING':'utf-8','UV_OFFLINE':'1'})
    start = time.time()
    p = subprocess.run([str(x) for x in args], cwd=cwd, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    receipt = {'command':[str(x) for x in args], 'exitCode':p.returncode, 'elapsedSeconds':round(time.time()-start,3), 'stdout':p.stdout, 'stderr':p.stderr}
    if log:
        write_json(log, receipt)
    if p.returncode not in ok:
        raise RuntimeError(f'Command failed ({p.returncode}): {args[0]}\n{p.stdout[-3500:]}\n{p.stderr[-3500:]}')
    return receipt

def new_dir(p):
    p = Path(p).resolve()
    p.mkdir(parents=True, exist_ok=False)
    return p

def source_binding():
    paths = [p for p in sorted((ROOT/'jia_director').rglob('*.py'))]
    paths += [p for p in sorted(RUNTIME.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc']
    paths += [ROOT/'runtime/patches.json', ROOT/'vendor/upstream-lock.json']
    values = [binding(p) for p in paths]
    return {'files':values, 'sha256':hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()}

def media_probe(video, *, expected=None, decode=True):
    r = run([tool('ffprobe'), '-v','error','-count_frames','-show_streams','-show_format','-of','json',video], timeout=300)
    j = json.loads(r['stdout'])
    streams = [s for s in j['streams'] if s['codec_type']=='video']
    if len(streams)!=1:
        raise ValueError('Exactly one video stream required')
    v=streams[0]
    def rate(value):
        n,d=map(float,value.split('/'))
        return n/d if d else 0
    info={'file':binding(video),'width':v['width'],'height':v['height'],'fps':rate(v['avg_frame_rate']),'nominalFps':rate(v['r_frame_rate']),'frames':int(v.get('nb_read_frames',0)), 'duration':float(v.get('duration',j['format']['duration'])),'codec':v['codec_name'],'pixFmt':v['pix_fmt'],'audioStreams':len([s for s in j['streams'] if s['codec_type']=='audio'])}
    if expected:
        for key in ('width','height','fps'):
            if abs(info[key]-expected[key])>1e-6:
                raise ValueError(f'Unexpected {key}: {info[key]} vs {expected[key]}')
        if info['frames'] != round(expected['duration']*expected['fps']):
            raise ValueError('Decoded frame count differs from requested sampling')
        if abs(info['duration']-expected['duration'])>1/expected['fps']+0.002:
            raise ValueError('Duration differs from requested sampling')
    if decode:
        run([tool('ffmpeg'),'-v','error','-i',video,'-f','null','-'],timeout=300)
        info['fullDecodePassed']=True
    return info

def finite_number(value, name, lower=0):
    if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or value<lower:
        raise ValueError(f'{name} must be a finite number >= {lower}')
    return value
