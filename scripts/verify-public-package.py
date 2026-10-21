"""Verify published source bytes and explicit omissions, including ZIP downloads."""
from pathlib import Path
import hashlib
import json
import re
import sys

root=Path(__file__).resolve().parents[1]
errors=[]
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def checked_path(relative):
    p=(root/relative).resolve()
    if not p.is_relative_to(root): raise ValueError('Manifest path escapes package')
    return p

packages=json.loads((root/'packages-manifest.json').read_text(encoding='utf-8-sig'))
skill_files=0
for name,package in packages['packages'].items():
    for relative,expected in package['files'].items():
        p=checked_path(f'skills/{name}/{relative}')
        if not p.is_file() or digest(p)!=expected:errors.append(f'Skill mismatch: {name}/{relative}')
        skill_files+=1
manifest=json.loads((root/'runtime-source-manifest.json').read_text(encoding='utf-8-sig'))
for item in manifest['files']:
    p=checked_path(item['publishedFile'])
    if not p.is_file() or digest(p)!=item['publishedSha256']:errors.append('Runtime mismatch: '+item['publishedFile'])
for item in manifest.get('addedRuntimeFiles',[]):
    p=checked_path(item['file'])
    if not p.is_file() or digest(p)!=item['sha256']:errors.append('Added runtime mismatch: '+item['file'])
exclusions=json.loads((root/'runtime-exclusions.json').read_text(encoding='utf-8-sig'))
for relative in exclusions['files']:
    if checked_path(relative).exists():errors.append('Excluded file unexpectedly present: '+relative)
for base in [root/'runtime/video-workspace/scripts',root/'runtime/video-workspace/runtime/source-film']:
    for p in base.rglob('*.mjs'):
        text=p.read_text(encoding='utf-8-sig')
        for relative in re.findall(r"(?:from\s+|import\s*)['\"](\.[^'\"]+)['\"]",text):
            if not (p.parent/relative).is_file():errors.append('Missing JS import in '+p.relative_to(root).as_posix()+': '+relative)
print(json.dumps({'passed':not errors,'skillFilesVerified':skill_files,'runtimeSourceFilesVerified':len(manifest['files']),
                  'addedRuntimeFilesVerified':len(manifest.get('addedRuntimeFiles',[])),
                  'omittedFilesVerified':len(exclusions['files']),'errors':errors},ensure_ascii=False,indent=2))
sys.exit(1 if errors else 0)
