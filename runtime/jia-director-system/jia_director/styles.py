from __future__ import annotations

from pathlib import Path
import os
import re

from .core import ROOT,read_json,write_json,binding,verify_binding,verify_nested_bindings

LIBRARY=Path(os.environ.get('JIA_STYLE_LIBRARY', ROOT/'library'))
REGISTRY=ROOT/'recipes/styles.local.json'

def build_registry():
    previous={x['id']:x['verification'] for x in read_json(REGISTRY)['families']} if REGISTRY.exists() else {}
    families=[]
    for folder in sorted((LIBRARY/'styles').glob('ST[0-9][0-9]')):
        p=folder/'README.md'
        text=p.read_text(encoding='utf-8-sig')
        name=text.splitlines()[0].lstrip('# ').strip()
        use=re.search(r'主用途[：:]\s*([^\n。]+)',text)
        sources=[]
        for line in text.splitlines():
            m=re.search(r'E:[\\/][^\r\n`<>]+',line)
            if not m:continue
            value=m.group(0).strip().rstrip('。；;，,')
            candidate=Path(value)
            if candidate.is_file():
                item=binding(candidate);item['role']='source' if candidate.suffix in ('.js','.mjs','.py','.html','.jsx','.tsx') else 'prompt-or-guide'
                if candidate.suffix in ('.js','.mjs','.html','.py') and candidate.stat().st_size<2_000_000:
                    code=candidate.read_text(encoding='utf-8-sig',errors='replace')
                    item['symbols']=sorted(set(re.findall(r'(?:function\s+|(?:const|let)\s+)([A-Za-z_$][\w$]*)\s*(?:\(|=)',code)))[:24]
                sources.append(item)
        # De-duplicate exact bindings while retaining all original family/variant choices.
        sources=list({x['path']:x for x in sources}.values())
        urls=list(dict.fromkeys(re.findall(r'https?://[^\s|)]+',text)))
        sections=re.split(r'^## ',text,flags=re.M)
        rules=next((s.split('\n',1)[1].strip() for s in sections if s.startswith('可复用规则\n')),'')
        variants=next((s.split('\n',1)[1].strip() for s in sections if s.startswith('保留的子风格')),'')
        families.append({'id':folder.name,'name':name,'primaryUse':use.group(1).strip() if use else None,'originalCard':binding(p),'sources':sources,'upstreamUrls':urls,'lookInvariants':rules,'variants':variants,'prompt':f'主题由王杰给定。采用{name}：{rules}。构图按新主题设计，背景、角色或道具、动作起中末分开描述；新方向先三种不同构图；读取所选源文件与样片，保留有效画法和原有声音要求。先实际短段、同源静帧和并排对照，再扩全片。','verification':{'bindingStatus':'source-bound' if sources else 'reference-only','executableSources':sum(x['role']=='source' for x in sources),'localEvidence':[],'userAccepted':False,'note':'来源与函数绑定不等于整家族画面已验证；通过style attach绑定具体实跑回执。'}})
    if len(families)!=24:raise ValueError('Expected the existing 24 style families; refusing to alter the selection set')
    for card in families:
        old=previous.get(card['id'],{})
        card['verification']['localEvidence']=[x for x in old.get('localEvidence',[]) if 'scope' in x]
        legacy=old.get('legacyUnscopedEvidence',[])+[x for x in old.get('localEvidence',[]) if 'scope' not in x]
        if legacy:card['verification']['legacyUnscopedEvidence']=legacy
    result={'version':'2.0.0','sourceNavigation':binding(LIBRARY/'docs/用途与风格导航.md'),'selectionAuthority':'Existing cumulative user choices in original library; not rewritten','families':families}
    write_json(REGISTRY,result)
    return result

def verify_registry(path=REGISTRY):
    registry=read_json(path);errors=[]
    for card in registry['families']:
        for b in [card['originalCard']]+card['sources']:
            try:verify_binding(b)
            except ValueError as e:errors.append(str(e))
        for receipt in card['verification']['localEvidence']:
            try:verify_nested_bindings(receipt)
            except ValueError as e:errors.append(str(e))
    return {'status':'failed' if errors else 'passed','families':len(registry['families']),'sourceBound':sum(x['verification']['bindingStatus']=='source-bound' for x in registry['families']),'executableFamilies':sum(x['verification']['executableSources']>0 for x in registry['families']),'errors':errors,'userAccepted':False}

def attach_evidence(style_id,receipt_path,scope_path):
    registry=read_json(REGISTRY);card=next((x for x in registry['families'] if x['id']==style_id),None)
    if card is None:raise ValueError('Unknown style family')
    report=read_json(receipt_path)
    if report.get('status')!='passed':raise ValueError('Only passed execution evidence can be attached')
    if not report.get('media') and not report.get('frames'):raise ValueError('Actual rendered media/frame evidence required')
    verify_nested_bindings(report)
    scope=read_json(scope_path)
    if scope.get('kind') not in ('implementation-study','reference-reproduction'):raise ValueError('Evidence scope must distinguish study from reference reproduction')
    if not all(scope.get(k) for k in ('variant','expected','originalSource','renderedSource')):raise ValueError('Variant, expected behavior and both source paths required')
    original=Path(scope['originalSource']).resolve();rendered=Path(scope['renderedSource']).resolve()
    if str(original) not in [b['path'] for b in card['sources']]:raise ValueError('Original source not in this style family')
    def bound_paths(obj):
        if isinstance(obj,dict):
            if 'path' in obj and 'sha256' in obj:yield obj['path']
            for v in obj.values():yield from bound_paths(v)
        elif isinstance(obj,list):
            for v in obj:yield from bound_paths(v)
    if str(rendered) not in set(bound_paths(report)):raise ValueError('Rendered source not bound to this execution receipt')
    interval=scope.get('interval',[])
    if len(interval)!=2 or not all(isinstance(x,(int,float)) for x in interval) or not 0<=interval[0]<interval[1] or (report.get('media') and interval[1]>report['media']['duration']):raise ValueError('Concrete valid time interval required')
    if scope['kind']=='reference-reproduction' and (scope.get('selfScore',0)<80 or not scope.get('reference') or not scope.get('comparison')):raise ValueError('H13 reproduction requires >=80 score and bound reference/comparison')
    if scope['kind']=='reference-reproduction':
        for key in ('reference','comparison'):
            value=scope[key]
            if isinstance(value,str):scope[key]=binding(value)
            elif isinstance(value,dict) and 'path' in value and 'sha256' in value:verify_binding(value)
            else:raise ValueError('Reference/comparison require actual local file bindings')
    evidence={'receipt':binding(receipt_path),'scope':scope,'scopeFile':binding(scope_path),'originalSource':binding(original),'renderedSource':binding(rendered)}
    if evidence not in card['verification']['localEvidence']:card['verification']['localEvidence'].append(evidence)
    card['verification']['note']='Specific attached runs only; family-wide fidelity and user acceptance remain separate'
    write_json(REGISTRY,registry)
    return {'status':'attached','style':style_id,'evidence':evidence,'userAccepted':False}
