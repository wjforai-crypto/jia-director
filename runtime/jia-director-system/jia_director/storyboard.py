from __future__ import annotations

import colorsys
import re
from decimal import Decimal
from pathlib import Path

from .core import read_json,write_json,binding,finite_number

GRAMMARS={'t1_3b1b','t2_keynote_ui','t3_finance_chart','y1_kurzgesagt','y2_vox','y3_whiteboard','y4_storytime','y5_kinetic_type'}
WEAK={'出现','显示','展示','呈现','淡入','淡出','停留','介绍','说明','讲解','弹出','保持'}
GENERIC={'标题','要点','文字','列表','背景','图标','卡片','空镜','黑场','空画面'}
TEXTUAL=re.compile(r'字卡|金句|标题页|纯文字|整页文字|清单页')

def text_units(text):
    return len(re.findall(r'[\u3400-\u9fff]|[A-Za-z0-9]+(?:[.,%][0-9]+)?|[^\s\w\u3400-\u9fff]',text))

def numeric_tokens(text):
    """Compare complete numeric quantities; never match 500 inside 1500."""
    digits={c:i for i,c in enumerate('零一二三四五六七八九')};digits.update({'〇':0,'两':2})
    scales={'十':10,'百':100,'千':1000,'万':10000,'亿':100000000}
    def chinese(value):
        if '点' in value:
            integer,fraction=value.split('点',1)
            return chinese(integer)+Decimal('0.'+''.join(str(digits[c]) for c in fraction))
        if not any(c in scales for c in value):return Decimal(''.join(str(digits[c]) for c in value))
        total=section=number=0
        for c in value:
            if c in digits:number=digits[c]
            elif scales[c]<10000:section+=(number or 1)*scales[c];number=0
            else:
                section+=number
                if scales[c]==100000000:total=(total+section)*scales[c]
                else:total+=section*scales[c]
                section=number=0
        return Decimal(total+section+number)
    text=re.sub(r'百分之([零〇一二两三四五六七八九十百千万亿点\d.]+)',r'\1%',text)
    pattern=r'(?<![\d.])(?:\d+(?:,\d{3})*(?:\.\d+)?[万亿]?|[零〇一二两三四五六七八九十百千万亿点]+)(?:元|秒|分钟|小时|年|岁|个|帧|%|％)?'
    result=[]
    for m in re.finditer(pattern,text):
        raw=m.group();unit=''
        for suffix in ('分钟','小时','元','秒','年','岁','个','帧','%','％'):
            if raw.endswith(suffix):unit=suffix;raw=raw[:-len(suffix)];break
        if len(raw)==1 and raw in digits and not unit:continue
        if re.match(r'\d',raw):
            scale=scales[raw[-1]] if raw[-1] in '万亿' else 1
            value=Decimal((raw[:-1] if scale!=1 else raw).replace(',',''))*scale
        else:value=chinese(raw)
        if unit in ('%','％'):unit='percent'
        result.append((value,unit))
    return result

def lint_storyboard(board, script=None):
    red=[];yellow=[]
    if not isinstance(board,dict):
        raise ValueError('Storyboard must be a JSON object')
    track=board.get('tier','track')=='track'
    for k in ('style','palette','character','shots'):
        if not board.get(k):red.append(f'Missing {k}')
    if not isinstance(board.get('shots'),list) or not board['shots']:
        return {'status':'failed','red':red+['Nonempty shots required'],'yellow':yellow}
    palette=board.get('palette',[])
    if isinstance(palette,list):
        for color in palette:
            if not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color):
                red.append('Palette colors must use #rrggbb');continue
            rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
            h,s,v=colorsys.rgb_to_hsv(*rgb)
            if 225<=h*360<=300 and s>=0.30:
                (yellow if board.get('allowBluePurple') else red).append('H01 blue-purple palette'+(' user exception recorded' if board.get('allowBluePurple') else ''))
    elif palette not in ('paper','poster','ink','navy','bauhaus','snow','wood','chalk'):
        red.append('Unknown palette')
    if isinstance(palette,list) and len(palette)>6:yellow.append('Palette has more than six colors')
    character=board.get('character',{})
    if not isinstance(character,dict) or character.get('mode') not in ('none','hands','back','frames','svg-flat'):
        red.append('Character mode must match H05 assets/hands/back/flat exception')
    elif character.get('mode')=='frames' and not character.get('source'):
        red.append('Character frames require source')
    elif character.get('mode')=='svg-flat' and not str(board.get('style','')).startswith(('37_rick_morty','52_south_park')):
        red.append('SVG full-character exception requires approved flat style')
    shots=board['shots'];previous=0;methods=set();text_count=0;ids=set();cameras=[]
    for i,shot in enumerate(shots):
        tag=f'shot[{i}]'
        if not isinstance(shot,dict):red.append(tag+' must be an object');continue
        sid=shot.get('id')
        if not sid or sid in ids:red.append(tag+' missing/duplicate id')
        ids.add(sid)
        try:
            a=finite_number(shot.get('start'),tag+'.start');b=finite_number(shot.get('end'),tag+'.end')
            if b<=a:red.append(tag+' end must follow start')
            if abs(a-previous)>1e-6:red.append(tag+' timeline gap or overlap')
            if track and not 2<=b-a<=6:red.append(tag+' H10 shot duration outside 2–6 seconds')
            previous=b
        except ValueError as e:red.append(str(e))
        if not shot.get('background'):red.append(tag+' missing background')
        objects=shot.get('objects',[])
        if not isinstance(objects,list) or not objects or all(x in GENERIC for x in objects):
            red.append(tag+' requires concrete role/prop objects')
        action=shot.get('action',{})
        if not isinstance(action,dict) or not all(isinstance(action.get(k),str) and action[k].strip() for k in ('from','verb','to')):
            red.append(tag+' requires visible action from/verb/to')
        elif action['verb'].strip() in WEAK:red.append(tag+' action is generic rather than observable')
        text=shot.get('text','')
        if not isinstance(text,str):red.append(tag+' text must be string');text=''
        if track and text_units(text)>8:red.append(tag+' H09 focus text exceeds eight units')
        textual=shot.get('textLed',False) or any(TEXTUAL.search(str(x)) for x in objects) or shot.get('method')=='y5_kinetic_type'
        text_count+=bool(textual)
        if (i==0 or i==len(shots)-1) and textual:red.append(tag+' H08 opening/ending must be concrete event')
        method=shot.get('method','')
        if method in GRAMMARS:methods.add(method)
        elif not method:red.append(tag+' missing actual implementation method')
        if method in GRAMMARS and shot.get('end',0)-shot.get('start',0)>8:red.append(tag+' parameterized clip exceeds eight seconds')
        camera=shot.get('camera','')
        if not camera:red.append(tag+' missing camera decision')
        cameras.append(camera)
        if script is not None:
            for number in numeric_tokens(text):
                if number not in numeric_tokens(script):red.append(tag+' on-screen number absent from locked script: '+str(number))
    if track and len(methods)>2:red.append('H04 more than two parameterized grammars')
    ratio=text_count/len(shots)
    if track and ratio>0.3:red.append('H09 text-led shot ratio exceeds 30%')
    for i in range(2,len(cameras)):
        cs=cameras[i-2:i+1]
        if all(re.search(r'推|砸入|zoom.?in',c,re.I) for c in cs):yellow.append(f'shots {i-1}–{i+1}: repeated push-in')
    if board.get('duration') is not None and abs(board['duration']-previous)>1e-6:red.append('Storyboard duration differs from final shot end')
    if not board.get('example'):red.append('H08 concrete example must be named')
    pending=board.get('newDirection',True) and not board.get('directionSelected',False)
    if pending:yellow.append('H07 submit three distinct compositions for Wang Jie selection; direction not yet approved')
    return {'kind':'jia-storyboard-preflight','status':'failed' if red else 'passed','tier':'track' if track else 'open','red':red,'yellow':yellow,'shots':len(shots),'textLedRatio':ratio,'grammars':sorted(methods),'requiresHumanDirectionSelection':pending,'userAccepted':False}

def check_file(path,output,script_path=None):
    path=Path(path)
    if path.suffix.lower()!='.json':raise ValueError('Use structured JSON storyboard; raw Markdown can be checked with the vendored storyboard_lint.py')
    result=lint_storyboard(read_json(path),Path(script_path).read_text(encoding='utf-8') if script_path else None)
    result['input']=binding(path)
    if script_path:result['script']=binding(script_path)
    write_json(output,result)
    return result
