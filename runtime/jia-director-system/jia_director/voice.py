from __future__ import annotations

import copy
import json
from pathlib import Path
import re

from .core import binding,read_json,write_json,sha256,new_dir,finite_number,run,tool,media_probe,verify_binding,verify_nested_bindings,source_binding
from .clip import validate_spec

def normalize_words(data):
    if isinstance(data,dict) and isinstance(data.get('transcription'),list):
        words=[]
        for segment in data['transcription']:
            for token in segment.get('tokens',[]):
                text=token.get('text','')
                if not text.strip() or re.fullmatch(r'\[_.+_\]',text):continue
                offsets=token.get('offsets',{})
                if 'from' not in offsets or 'to' not in offsets:raise ValueError('Whisper token lacks actual offsets')
                words.append({'text':text,'start':offsets['from']/1000,'end':offsets['to']/1000})
        precision='ASR-token-offsets'
    else:
        raw=data.get('words') if isinstance(data,dict) else data
        if not isinstance(raw,list) or not raw:raise ValueError('No timed words')
        words=[{'text':w.get('text',w.get('word','')),'start':w.get('start'),'end':w.get('end')} for w in raw]
        precision=data.get('precision','provided-word-times') if isinstance(data,dict) else 'provided-word-times'
    previous=-1
    for w in words:
        if not isinstance(w['text'],str) or not w['text']:raise ValueError('Word text is empty')
        finite_number(w['start'],'word.start');finite_number(w['end'],'word.end')
        if w['end']<w['start'] or w['start']<previous:raise ValueError('Word timestamps are reversed or unordered')
        previous=w['start']
    if not words:raise ValueError('No lexical words after removing special tokens')
    return words,precision

def keyword_interval(words,keyword,occurrence=None):
    if not keyword:raise ValueError('Keyword must not be empty')
    text='';chars=[]
    for i,w in enumerate(words):
        for ch in w['text']:
            if ch.isspace() or re.match(r'[^\w\u3400-\u9fff]',ch):continue
            text+=ch;chars.append(i)
    key=''.join(ch for ch in keyword if not ch.isspace() and not re.match(r'[^\w\u3400-\u9fff]',ch))
    if not key:raise ValueError('Keyword must contain lexical content')
    matches=[m.start() for m in re.finditer(re.escape(key),text)]
    if not matches:raise ValueError('Keyword absent from actual word table: '+keyword)
    if len(matches)>1 and occurrence is None:raise ValueError('Ambiguous repeated keyword requires occurrence')
    index=0 if occurrence is None else occurrence
    if not isinstance(index,int) or index<0 or index>=len(matches):raise ValueError('Keyword occurrence outside available matches')
    a=matches[index];b=a+len(key)-1
    return {'keyword':keyword,'occurrence':index,'start':words[chars[a]]['start'],'end':words[chars[b]]['end'],'firstToken':chars[a],'lastToken':chars[b]}

def compile_cues(words_path,audio_path,spec_path,mapping_path,output,*,offset=0,asr_receipt=None):
    finite_number(offset,'offset')
    words_path=Path(words_path).resolve();audio_path=Path(audio_path).resolve();spec_path=Path(spec_path).resolve()
    words,precision=normalize_words(read_json(words_path))
    mapping=read_json(mapping_path)
    spec=validate_spec(read_json(spec_path),spec_path.parent)
    if asr_receipt:
        asr=read_json(asr_receipt)
        if asr.get('audioSha256')!=sha256(audio_path) or asr.get('rawJsonSha256')!=sha256(words_path):
            raise ValueError('ASR word table is not bound to this exact audio')
    elif precision=='ASR-token-offsets':
        raise ValueError('ASR input requires its audio/JSON hash receipt')
    audio_info=json.loads(run([tool('ffprobe'),'-v','error','-show_format','-of','json',audio_path])['stdout'])
    duration=float(audio_info['format']['duration'])
    if any(w['end']>duration+0.05 for w in words):raise ValueError('Word table extends past actual audio')
    if not isinstance(mapping,list) or not mapping:raise ValueError('Nonempty cue mapping required')
    events=[]
    for item in mapping:
        index=item['cueIndex']
        if not isinstance(index,int) or isinstance(index,bool) or index<0 or index>=len(spec['cues']):raise ValueError('cueIndex outside spec')
        event=keyword_interval(words,item['keyword'],item.get('occurrence'))
        at=event['start']-offset
        if at<0 or at>=spec['duration']:raise ValueError('Keyword falls outside requested clip interval')
        snapped=round(at*spec['fps'])/spec['fps']
        last_sample=(round(spec['duration']*spec['fps'])-1)/spec['fps']
        if snapped>last_sample+1e-9:raise ValueError('Rounded keyword cue has no output frame; extend clip duration')
        spec['cues'][index]['at']=snapped
        events.append({**event,'cueIndex':index,'localTime':snapped,'mainTime':snapped+offset,'samplingErrorSeconds':snapped-at})
    spec['cues'].sort(key=lambda q:q['at'])
    out=new_dir(output);write_json(out/'clip.json',spec)
    evidence={'kind':'jia-word-cue-adapter','status':'passed','audio':binding(audio_path),'words':binding(words_path),'sourceSpec':binding(spec_path),'mapping':binding(mapping_path),'clip':binding(out/'clip.json'),'offset':offset,'duration':spec['duration'],'precision':precision,'forcedAlignment':False,'humanWordTimingReviewed':False,'events':events,'userVoiceAccepted':False}
    if asr_receipt:evidence['asrReceipt']=binding(asr_receipt)
    write_json(out/'cues.receipt.json',evidence)
    return evidence

def compose(timeline_path,output):
    timeline_path=Path(timeline_path).resolve();timeline=read_json(timeline_path)
    v=timeline['video']
    for key in ('width','height','fps','duration'):finite_number(v[key],key,0.001)
    if any(not isinstance(v[k],int) or isinstance(v[k],bool) for k in ('width','height','fps')):raise ValueError('Integer video dimensions/fps required')
    if v['width']%2 or v['height']%2:raise ValueError('Even dimensions required')
    shots=timeline.get('shots',[])
    if not shots:raise ValueError('Timeline shots required')
    def on_grid(t):
        if abs(t*v['fps']-round(t*v['fps']))>1e-6:raise ValueError('Timeline times must lie on output frame grid')
    on_grid(v['duration'])
    timeline_binding=binding(timeline_path);source=source_binding()
    base=timeline_path.parent;out=new_dir(output);concat=[];evidence=[];total=0
    for i,shot in enumerate(shots):
        path=(base/shot['file']).resolve();d=finite_number(shot['duration'],'shot.duration',0.001)
        on_grid(d)
        if not path.is_file():raise ValueError('Missing timeline media')
        probe=media_probe(path,decode=False)
        if probe['duration']+1/v['fps']<d:raise ValueError('Shot shorter than declared interval')
        part=out/f'part-{i:03d}.mp4'
        run([tool('ffmpeg'),'-v','error','-i',path,'-t',str(d),'-vf',f"scale={v['width']}:{v['height']}:force_original_aspect_ratio=decrease,pad={v['width']}:{v['height']}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={v['fps']}",'-an','-c:v','libx264','-pix_fmt','yuv420p',part],log=out/f'part-{i:03d}.command.json')
        concat.append(f"file '{part.name}'")
        evidence.append(binding(path));total+=d
    if abs(total-v['duration'])>1e-6:raise ValueError('Timeline duration differs from sum of shots')
    (out/'concat.txt').write_text('\n'.join(concat)+'\n',encoding='utf-8')
    basevideo=out/'base.mp4'
    run([tool('ffmpeg'),'-v','error','-f','concat','-safe','0','-i',out/'concat.txt','-c','copy',basevideo],log=out/'concat.command.json')
    overlays=timeline.get('overlays',[]);current=basevideo
    for i,overlay in enumerate(overlays):
        p=(base/overlay['file']).resolve();a=finite_number(overlay['start'],'overlay.start');d=finite_number(overlay['duration'],'overlay.duration',0.001)
        on_grid(a);on_grid(d)
        if a+d>v['duration']+1e-6:raise ValueError('Overlay beyond parent timeline')
        op=media_probe(p,decode=False)
        if not op['pixFmt'].startswith(('yuva','rgba','bgra','argb','abgr','gbrap','ya')) or op['duration']+1/v['fps']<d:raise ValueError('Overlay requires actual alpha channel and sufficient duration')
        nextvideo=out/f'overlay-{i:03d}.mp4'
        graph=f"[1:v]trim=duration={d},setpts=PTS-STARTPTS+{a}/TB[ol];[0:v][ol]overlay=x={int(overlay.get('x',0))}:y={int(overlay.get('y',0))}:enable='gte(t,{a})*lt(t,{a+d})':eof_action=pass:format=auto[v]"
        run([tool('ffmpeg'),'-v','error','-i',current,'-i',p,'-filter_complex',graph,'-map','[v]','-an','-c:v','libx264','-pix_fmt','yuv420p','-r',str(v['fps']),'-t',str(v['duration']),nextvideo],timeout=600,log=out/f'overlay-{i:03d}.command.json')
        evidence.append(binding(p));current=nextvideo
    final=out/'film.mp4';audio=timeline.get('audio')
    if audio:
        p=(base/audio['file']).resolve();evidence.append(binding(p))
        ad=float(json.loads(run([tool('ffprobe'),'-v','error','-show_format','-of','json',p])['stdout'])['format']['duration'])
        if ad+0.02<v['duration']:raise ValueError('Audio shorter than timeline; no automatic padding or looping')
        run([tool('ffmpeg'),'-v','error','-i',current,'-i',p,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(v['duration']),final],log=out/'audio.command.json')
    else:
        import shutil
        shutil.copyfile(current,final)
    verify_nested_bindings([timeline_binding,source,evidence])
    result={'kind':'jia-parent-composition','status':'passed','input':timeline_binding,'source':source,'sources':evidence,'media':media_probe(final,expected=v),'subtitleOwner':'parent-timeline','audioOwner':'parent-timeline','userAccepted':False,'reportPath':str(out/'receipt.json')}
    if result['media']['audioStreams']!=(1 if audio else 0):raise ValueError('Unexpected audio owner/stream count')
    write_json(out/'receipt.json',result)
    return result
