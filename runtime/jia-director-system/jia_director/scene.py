from pathlib import Path
import sys

from .core import ENGINE,RUNTIME,new_dir,run,write_json,source_binding,media_probe,binding,verify_nested_bindings,finite_number

def render_scene(output,*,film='demos/jia_v2',solo=None,duration=12,fps=30,width=1280,height=720,stills=None):
    import re
    if not re.fullmatch(r'(?:demos/)?[a-z0-9_]+',film):raise ValueError('Invalid registered film name')
    finite_number(duration,'duration',0.01)
    if duration>300 or any(isinstance(x,bool) or not isinstance(x,int) or x<=0 for x in (fps,width,height)) or width%2 or height%2:raise ValueError('Invalid scene sampling')
    if stills is not None and (not stills or any(not 0<=t<duration for t in stills)):raise ValueError('Stills outside scene interval')
    out=new_dir(output);target=out/'scene.mp4'
    command=[sys.executable,'-X','utf8',ENGINE/'render.py','--film',film,'--from','0','--to',str(duration),'--fps',str(fps),'--width',str(width),'--height',str(height),'--no-counter','--out',target]
    if solo:command+=['--solo',solo]
    if stills is not None:
        command[command.index('--out')+1]=str(out/'frames')
        command+=['--stills',','.join(map(str,stills))]
    result={'kind':'jia-scene-render','source':source_binding(),'film':film,'solo':solo,'status':'running','userAccepted':False,'reportPath':str(out/'receipt.json')}
    try:
        run(command,timeout=1800,log=out/'command.json')
        if stills is None:result['media']=media_probe(target,expected={'width':width,'height':height,'fps':fps,'duration':duration})
        else:result['frames']=[binding(p) for p in sorted((out/'frames').glob('*.png'))]
        if stills is not None and len(result['frames'])!=len(stills):raise ValueError('Requested scene frames missing')
        verify_nested_bindings(result['source'])
        result['status']='passed'
    except Exception as e:
        result['status']='failed';result['error']=str(e);write_json(out/'receipt.json',result);raise
    write_json(out/'receipt.json',result)
    return result
