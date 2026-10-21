import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .core import ROOT,ENGINE,CONFIG_PATH,read_json,write_json,binding,run,config,media_probe

def main():
    p=argparse.ArgumentParser(prog='jia-director',description='导演系统2.0本地执行与验证')
    sub=p.add_subparsers(dest='command',required=True)
    d=sub.add_parser('doctor');d.add_argument('--out')
    c=sub.add_parser('clip');c.add_argument('action',choices=['validate','render','stills','audit','qa']);c.add_argument('--spec',required=True);c.add_argument('--out');c.add_argument('--times',default='0,1,2');c.add_argument('--alpha',action='store_true')
    s=sub.add_parser('storyboard');s.add_argument('--input',required=True);s.add_argument('--out',required=True);s.add_argument('--script')
    r=sub.add_parser('stress');r.add_argument('--spec',nargs='+',required=True);r.add_argument('--out',required=True);r.add_argument('--workers',type=int,default=2);r.add_argument('--full',action='store_true')
    v=sub.add_parser('voice-cues');v.add_argument('--words',required=True);v.add_argument('--audio',required=True);v.add_argument('--spec',required=True);v.add_argument('--mapping',required=True);v.add_argument('--out',required=True);v.add_argument('--offset',type=float,default=0);v.add_argument('--asr-receipt')
    co=sub.add_parser('compose');co.add_argument('--timeline',required=True);co.add_argument('--out',required=True)
    iq=sub.add_parser('inspect-final');iq.add_argument('--video',required=True);iq.add_argument('--out',required=True);iq.add_argument('--spec');iq.add_argument('--production-receipt');iq.add_argument('--allow-blue-purple')
    de=sub.add_parser('deliver');de.add_argument('--video',required=True);de.add_argument('--qa',required=True);de.add_argument('--review',required=True);de.add_argument('--out',required=True)
    ve=sub.add_parser('verify');ve.add_argument('--manifest',required=True)
    st=sub.add_parser('style');st.add_argument('action',choices=['build','list','verify','attach']);st.add_argument('--id');st.add_argument('--receipt');st.add_argument('--scope')
    fb=sub.add_parser('feedback');fb.add_argument('--input',required=True);fb.add_argument('--out',required=True)
    sc=sub.add_parser('scene');sc.add_argument('--out',required=True);sc.add_argument('--film',default='demos/jia_v2');sc.add_argument('--solo');sc.add_argument('--duration',type=float,default=12);sc.add_argument('--fps',type=int,default=30);sc.add_argument('--width',type=int,default=1280);sc.add_argument('--height',type=int,default=720);sc.add_argument('--times')
    args=p.parse_args()
    if args.command=='doctor':
        import importlib.util
        result={'version':__version__,'python':sys.executable,'pythonVersion':sys.version,'config':binding(CONFIG_PATH),'browser':{'path':config()['render']['browserPath'],'exists':Path(config()['render']['browserPath']).is_file()},'dependencies':{x:importlib.util.find_spec(x) is not None for x in ['playwright','PIL','numpy','cv2']},'grammars':sorted(read_json(ENGINE/'clip_schema.json')['grammars']),'videoApiEnabled':False,'userAccepted':False}
        for name in ['ffmpeg','ffprobe']:
            r=run([name,'-version']);result[name]=r['stdout'].splitlines()[0]
        from .environment import browser_probe
        result['actualBrowser']=browser_probe()
        b=result['actualBrowser'];result['status']='passed' if result['browser']['exists'] and all(result['dependencies'].values()) and b.get('canvas2d') and b.get('shaderPassed') else 'failed'
        if args.out:write_json(args.out,result)
    elif args.command=='feedback':
        from .feedback import record_repair
        result=record_repair(args.input,args.out)
    elif args.command=='scene':
        from .scene import render_scene
        result=render_scene(args.out,film=args.film,solo=args.solo,duration=args.duration,fps=args.fps,width=args.width,height=args.height,stills=[float(t) for t in args.times.split(',')] if args.times else None)
    elif args.command=='style':
        from .styles import build_registry,verify_registry,attach_evidence,REGISTRY
        if args.action=='build':
            r=build_registry();result={'families':len(r['families']),'registry':str(REGISTRY)}
        elif args.action=='verify':result=verify_registry()
        elif args.action=='attach':
            if not args.id or not args.receipt or not args.scope:p.error('style attach requires --id, --receipt and --scope')
            result=attach_evidence(args.id,args.receipt,args.scope)
        else:
            r=read_json(REGISTRY);result=[{'id':x['id'],'name':x['name'],'primaryUse':x['primaryUse'],'status':x['verification']} for x in r['families'] if not args.id or x['id']==args.id]
    elif args.command=='inspect-final':
        from .delivery import inspect_final
        result=inspect_final(args.video,args.out,spec=args.spec,production_receipt=args.production_receipt,allow_blue_purple=args.allow_blue_purple)
        print(json.dumps({k:result[k] for k in ('status','errors','warnings','reportPath')},ensure_ascii=False))
        return 1 if result['status']!='passed' else 0
    elif args.command=='deliver':
        from .delivery import deliver
        result=deliver(args.video,args.qa,args.review,args.out)
    elif args.command=='verify':
        from .delivery import verify_delivery
        result=verify_delivery(args.manifest)
    elif args.command=='voice-cues':
        from .voice import compile_cues
        result=compile_cues(args.words,args.audio,args.spec,args.mapping,args.out,offset=args.offset,asr_receipt=args.asr_receipt)
    elif args.command=='compose':
        from .voice import compose
        result=compose(args.timeline,args.out)
    elif args.command=='stress':
        from .regression import regression
        result=regression(args.spec,args.out,workers=args.workers,full=args.full)
        print(json.dumps({k:result[k] for k in ('status','passed','total')},ensure_ascii=False))
        return 0 if result['status']=='passed' else 1
    elif args.command=='storyboard':
        from .storyboard import check_file
        result=check_file(args.input,args.out,args.script)
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 1 if result['red'] else 0
    elif args.command=='clip':
        from .clip import validate_spec,render,qa
        if args.action=='validate':
            s=Path(args.spec).resolve();result=validate_spec(read_json(s),s.parent)
        else:
            if not args.out:p.error('--out is required for this action')
            if args.action=='qa':result=qa(args.spec,args.out)
            else:result=render(args.spec,args.out,stills=[float(t) for t in args.times.split(',')] if args.action=='stills' else None,alpha=args.alpha,audit=args.action=='audit')
    failed=isinstance(result,dict) and result.get('status') in ('failed','layout-failed')
    if isinstance(result,dict) and 'reportPath' in result:
        result={k:result[k] for k in ('kind','status','reportPath','media','layoutExitCode') if k in result}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 1 if failed else 0

if __name__=='__main__':
    try:raise SystemExit(main() or 0)
    except Exception as e:
        print(str(e),file=sys.stderr)
        raise SystemExit(1)
