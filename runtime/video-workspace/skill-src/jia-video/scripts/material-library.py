"""Jia-video's local stock library. No generation, credentials, or timeline ownership."""
import argparse
from contextlib import closing
import hashlib
import html
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser
from pathlib import Path
from fractions import Fraction

CONFIG = Path(os.environ.get('JIA_VIDEO_WORKSPACE', 'E:/开发项目/视频剪辑skill')) / 'config/video-workflow.json'
UA = 'Jia-video/3.0 (bounded selected public-media retrieval)'
if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
HOSTS = {'commons.wikimedia.org', 'upload.wikimedia.org', 'images-api.nasa.gov',
         'images-assets.nasa.gov', 'mixkit.co', 'assets.mixkit.co'}

def check(condition, message):
    if not condition:
        raise ValueError(message)

def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def write_new(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)

def native(args, timeout=180):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    check(result.returncode == 0, result.stderr[-1600:] or 'Native operation failed')
    return result.stdout

class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        approved_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def approved_url(url):
    parsed = urllib.parse.urlsplit(url)
    check(parsed.scheme == 'https' and parsed.hostname in HOSTS and not parsed.username and not parsed.password
          and parsed.port in (None, 443), 'Only configured public HTTPS source hosts are supported')
    return url

def response(url):
    approved_url(url)
    return urllib.request.build_opener(PublicRedirect()).open(
        urllib.request.Request(url, headers={'User-Agent': UA}), timeout=25)

def metadata(url):
    with response(url) as stream:
        data = stream.read(2_000_001)
        check(len(data) <= 2_000_000, 'Metadata too large')
        return data.decode('utf-8')

def info(path, cfg, full_decode=True):
    data = json.loads(native([cfg['tools']['ffprobeCommand'], '-v', 'error', '-protocol_whitelist', 'file,pipe',
                              '-show_streams', '-show_format', '-of', 'json', path], 30))
    video = next((s for s in data['streams'] if s['codec_type'] == 'video'), None)
    check(video is not None, 'No video stream')
    duration = float(data['format']['duration'])
    check(math.isfinite(duration) and duration > 0, 'Invalid duration')
    if full_decode:
        native([cfg['tools']['ffmpegCommand'], '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
                '-i', path, '-f', 'null', '-'], 180)
    return {'width': video['width'], 'height': video['height'], 'duration': duration,
            'codec': video['codec_name'], 'fps': video['avg_frame_rate'], 'fullDecodePassed': full_decode,
            'audioStreams': sum(s['codec_type'] == 'audio' for s in data['streams'])}

def database(root):
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'catalog.sqlite', timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE, path TEXT, title TEXT, tags TEXT, origins TEXT, media TEXT)')
    return db

def rows(root):
    if not (root / 'catalog.sqlite').exists():
        return []
    with closing(sqlite3.connect('file:' + (root / 'catalog.sqlite').as_posix() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        return [unpack(row) for row in db.execute('SELECT * FROM assets ORDER BY title')]

def unpack(row):
    result = dict(row)
    for name in ['tags', 'origins', 'media']:
        result[name] = json.loads(result[name])
    return result

def origin_ok(origin):
    check(isinstance(origin, dict) and all(str(origin.get(x, '')).strip() for x in ['provider', 'title', 'sourcePage', 'license']),
          'Origin requires provider, title, sourcePage and exact license; do not infer rights from a URL')

def register(source, origin, tags, cfg, root):
    source = Path(source).resolve()
    origin_ok(origin)
    check(source.is_file() and source.stat().st_size > 0, 'Input file missing or empty')
    check(source.suffix.lower() in ['.mp4', '.webm', '.mov', '.mkv'], 'Unsupported video extension')
    check(source.stat().st_size <= cfg['materials']['maxDownloadBytes'], 'Input exceeds configured byte limit')
    digest = sha(source)
    media = info(source, cfg)
    # Recheck the source after decoding so a changing file cannot silently enter the catalog.
    check(sha(source) == digest, 'Source changed during validation')
    with closing(database(root)) as db, db:
        old = db.execute('SELECT * FROM assets WHERE sha256=?', (digest,)).fetchone()
        if old:
            record = unpack(old)
            check(Path(record['path']).is_file() and sha(record['path']) == digest,
                  'CACHE_INVALID: existing library file is missing or corrupt; preserve it for bounded repair')
            info(record['path'], cfg)
            origins = record['origins']
            if origin not in origins:
                origins.append(origin)
            merged_tags = sorted(set(record['tags'] + tags))
            db.execute('UPDATE assets SET origins=?,tags=? WHERE id=?',
                       (json.dumps(origins, ensure_ascii=False), json.dumps(merged_tags, ensure_ascii=False), record['id']))
            return {**record, 'origins': origins, 'tags': merged_tags, 'cacheReused': True, 'reviewRequired': True}
        asset_id = 'stock-' + digest[:24]
        folder = root / 'files'
        folder.mkdir(exist_ok=True)
        destination = folder / (digest + source.suffix.lower())
        check(not destination.exists(), 'Unregistered destination exists; preserve it for inspection')
        with source.open('rb') as src, destination.open('xb') as dst:
            shutil.copyfileobj(src, dst)
        check(sha(destination) == digest and sha(source) == digest, 'Source or copy changed')
        db.execute('INSERT INTO assets VALUES (?,?,?,?,?,?,?)',
                   (asset_id, digest, str(destination), origin['title'], json.dumps(tags, ensure_ascii=False),
                    json.dumps([origin], ensure_ascii=False), json.dumps(media)))
        return {'id': asset_id, 'sha256': digest, 'path': str(destination), 'title': origin['title'],
                'tags': tags, 'origins': [origin], 'media': media, 'cacheReused': False, 'reviewRequired': True}

class PageTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.options, self.modals = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'input' and attrs.get('name') == 'download-option':
            self.options.append(attrs)
        if 'data-download--modal-url-value' in attrs:
            self.modals.append(attrs)

def mixkit_candidate(page):
    check(urllib.parse.urlsplit(page).hostname == 'mixkit.co', 'Expected a Mixkit detail page')
    body = metadata(page)
    check('data-license="videoFree"' in body, 'This version is not confirmed Mixkit Free; stop rather than use Restricted')
    parser = PageTags()
    parser.feed(body)
    option = next((x for x in parser.options if 'type=720p' in x.get('value', '')), None)
    check(option, 'Normal 720p download option not found')
    parser = PageTags()
    parser.feed(metadata(urllib.parse.urljoin(page, option['value'])))
    check(parser.modals, 'Normal download modal did not provide a file')
    modal = parser.modals[0]
    title = page.rstrip('/').split('/')[-1]
    return {'provider': 'mixkit', 'id': modal.get('data-download--modal-item-id-value'), 'title': title,
            'sourcePage': page, 'license': 'Mixkit Stock Video Free License', 'licenseUrl': 'https://mixkit.co/license/#videoFree',
            'downloadUrl': modal['data-download--modal-url-value'], 'extension': '.mp4', 'reviewRequired': True}

def online_search(provider, query, limit):
    if provider == 'commons':
        params = {'action': 'query', 'generator': 'search', 'gsrsearch': 'filetype:video ' + query,
                  'gsrnamespace': 6, 'gsrlimit': limit, 'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata',
                  'format': 'json', 'formatversion': 2}
        data = json.loads(metadata('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(params)))
        check('error' not in data, 'Commons API returned an error')
        results = []
        for item in data.get('query', {}).get('pages', []):
            media = item.get('imageinfo', [{}])[0]
            if not media.get('mime', '').startswith('video/'):
                continue
            ext = media.get('extmetadata', {})
            field = lambda name: ext.get(name, {}).get('value', '')
            suffix = Path(urllib.parse.urlsplit(media['url']).path).suffix.lower()
            results.append({'provider': 'commons', 'id': str(item['pageid']), 'title': item['title'],
                            'sourcePage': media['descriptionurl'], 'license': field('LicenseShortName'),
                            'licenseUrl': field('LicenseUrl'), 'author': html.unescape(field('Artist')),
                            'downloadUrl': media['url'], 'extension': suffix, 'bytes': media.get('size'),
                            'description': field('ImageDescription'), 'reviewRequired': True})
        return results
    params = {'q': query, 'media_type': 'video', 'page_size': limit}
    data = json.loads(metadata('https://images-api.nasa.gov/search?' + urllib.parse.urlencode(params)))
    return [{'provider': 'nasa', 'id': item['data'][0]['nasa_id'], 'title': item['data'][0]['title'],
             'sourcePage': 'https://images.nasa.gov/details/' + urllib.parse.quote(item['data'][0]['nasa_id'], safe=''),
             'description': item['data'][0].get('description', ''), 'eventOrPublishedDate': item['data'][0].get('date_created'),
             'author': 'NASA/' + item['data'][0].get('center', ''), 'license': 'NASA media guidelines; verify item-specific third-party content',
             'licenseUrl': 'https://www.nasa.gov/nasa-brand-center/images-and-media/', 'reviewRequired': True}
            for item in data.get('collection', {}).get('items', [])]

def download(candidate, cfg, root):
    origin_ok(candidate)
    provider = candidate['provider']
    check(provider in ['mixkit', 'commons', 'nasa'], 'Provider requires normal website download then local import')
    for asset in rows(root):
        if any(o.get('provider') == provider and o.get('id') == candidate.get('id') and o.get('sourcePage') == candidate['sourcePage'] for o in asset['origins']):
            return register(asset['path'], candidate, [], cfg, root)
    if provider == 'nasa':
        data = json.loads(metadata('https://images-api.nasa.gov/asset/' + urllib.parse.quote(candidate['id'], safe='')))
        urls = [x['href'] for x in data.get('collection', {}).get('items', [])]
        url = next((x for x in urls if x.endswith('~medium.mp4')), None)
        check(url, 'No official medium MP4 rendition available')
        parts = urllib.parse.urlsplit(url)
        url = urllib.parse.urlunsplit(('https', parts.netloc, urllib.parse.quote(parts.path, safe='/%~'), parts.query, ''))
        candidate = {**candidate, 'downloadUrl': url, 'extension': '.mp4', 'rendition': 'medium'}
    url = candidate['downloadUrl']
    extension = candidate['extension']
    check(extension in ['.mp4', '.webm', '.mov', '.mkv'], 'Unsupported source video type; use explicit local conversion')
    # Only the media host of the selected provider may serve its file.
    expected = {'mixkit': 'assets.mixkit.co', 'commons': 'upload.wikimedia.org', 'nasa': 'images-assets.nasa.gov'}[provider]
    check(urllib.parse.urlsplit(url).hostname == expected, 'Selected file does not match provider host')
    folder = root / 'receipts' / uuid.uuid4().hex
    folder.mkdir(parents=True)
    partial = folder / ('download.partial' + extension)
    start = time.monotonic()
    receipt = {'source': candidate, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'authenticated': False}
    try:
        total = 0
        with response(url) as stream:
            declared = stream.headers.get('Content-Length')
            content_type = stream.headers.get('Content-Type', '')
            check(content_type.startswith('video/') or content_type.startswith('application/octet-stream'), 'Response is not media')
            check(not declared or int(declared) <= cfg['materials']['maxDownloadBytes'], 'File exceeds configured byte limit')
            with partial.open('xb') as dest:
                while True:
                    check(time.monotonic() - start <= cfg['materials']['downloadDeadlineSeconds'], 'Download deadline exceeded')
                    chunk = stream.read(128 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    check(total <= cfg['materials']['maxDownloadBytes'], 'Stream exceeds configured byte limit')
                    dest.write(chunk)
            check(not declared or int(declared) == total, 'Truncated download')
            receipt.update(httpStatus=stream.status, bytes=total, contentType=content_type)
        validated = info(partial, cfg)
        complete = folder / ('source' + extension)
        partial.rename(complete)
        asset = register(complete, candidate, [], cfg, root)
        receipt.update(status='downloaded-and-validated', sha256=asset['sha256'], assetId=asset['id'], media=validated)
        return {**asset, 'downloadReceipt': str(folder / 'receipt.json')}
    except Exception as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        receipt['elapsedSeconds'] = round(time.monotonic() - start, 3)
        write_new(folder / 'receipt.json', receipt)

def semantic(command, cfg, cfg_path, root, query=None, limit=6):
    runtime = cfg['materials']['semantic']
    args = [runtime['pythonPath'], Path(__file__).with_name('material-videoseek.py'), command, '--config', cfg_path, '--library-root', root]
    if query:
        args += ['--query', query, '--limit', limit]
    return json.loads(native(args, 600))

def cut(asset, args, cfg, root):
    check(args.review_note and args.review_note.strip(), 'Provide a concrete review note for the selected shot')
    check(sha(asset['path']) == asset['sha256'], 'CACHE_INVALID: source hash changed')
    media = info(asset['path'], cfg)
    check(math.isfinite(args.start) and math.isfinite(args.end) and 0 <= args.start < args.end <= media['duration'], 'Invalid source interval')
    output = Path(args.output).resolve()
    check((root / 'files').resolve() not in output.parents, 'Do not write selected clips into the indexed original-file directory')
    check(output.suffix.lower() == '.mp4' and not output.exists() and not Path(str(output) + '.asset.json').exists(), 'Choose a new MP4 output and sidecar')
    check(args.fps >= 1 and args.fps <= 120 and args.width >= 16 and args.width % 2 == 0, 'Invalid output fps or even width')
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.stem + '-' + uuid.uuid4().hex[:8] + '.partial.mp4')
    native([cfg['tools']['ffmpegCommand'], '-v', 'error', '-ss', args.start, '-i', asset['path'], '-t', args.end - args.start,
            '-vf', f'scale={args.width}:-2,fps={args.fps}', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-n', partial])
    actual = info(partial, cfg)
    check(abs(actual['duration'] - (args.end - args.start)) <= 1.1 / args.fps, 'Actual duration differs from selected source interval')
    check(sha(asset['path']) == asset['sha256'], 'Source changed during cut')
    check(not output.exists(), 'Output appeared during render; preserve it')
    # Exclusive publication prevents a parallel exporter from being overwritten.
    os.link(partial, output)
    partial.unlink()
    result = {'kind': 'jia-video-selected-stock-clip', 'assetId': asset['id'], 'sourcePath': asset['path'],
              'sourceSha256': asset['sha256'], 'sourceIn': args.start, 'sourceOut': args.end, 'output': str(output),
              'outputSha256': sha(output), 'media': actual, 'origins': asset['origins'], 'reviewNote': args.review_note,
              'transformations': ['source-interval-selection', 'scaled', 'reencoded', 'muted'], 'userAcceptance': 'pending'}
    write_new(str(output) + '.asset.json', result)
    return result

def run(args):
    cfg_path = Path(args.config).resolve()
    cfg = json.loads(cfg_path.read_text(encoding='utf-8-sig'))
    root = Path(args.library_root or cfg['materials']['libraryRoot']).resolve()
    command = args.command
    if command == 'doctor':
        runtime = cfg['materials']['semantic']
        return {'kind': 'jia-video-material-doctor', 'libraryRoot': str(root), 'registeredAssets': len(rows(root)),
                'publicProviders': ['commons', 'nasa', 'mixkit-detail-page'], 'networkRequests': 0,
                'semanticRuntimeReady': all(Path(runtime[x]).exists() for x in ['pythonPath', 'sourceRoot', 'modelsRoot']),
                'semanticIndexExists': (root / 'index-data').exists(), 'reviewRequired': True}
    if command == 'import':
        origin = json.loads(Path(args.origin).read_text(encoding='utf-8-sig'))
        return register(args.input, origin, args.tags or [], cfg, root)
    if command == 'download':
        check(args.license_review and args.license_review.strip(), 'Record intended usage and license review before download or cache adoption')
        if args.page:
            cached = next((a for a in rows(root) if any(o.get('provider') == 'mixkit' and o.get('sourcePage') == args.page for o in a['origins'])), None)
            if cached:
                origin = next(o for o in cached['origins'] if o.get('sourcePage') == args.page)
                return register(cached['path'], {**origin, 'licenseReview': args.license_review}, [], cfg, root)
            candidate = mixkit_candidate(args.page)
        else:
            check(args.input and args.id, 'Use a selected Mixkit --page or a saved candidate list --input and --id')
            records = json.loads(Path(args.input).read_text(encoding='utf-8-sig'))
            candidates = records['candidates']
            candidate = next((x for x in candidates if x['id'] == args.id), None)
            check(candidate is not None, 'Candidate ID not found')
        check(args.license_review and args.license_review.strip(), 'Record the exact intended usage and license review before download')
        candidate['licenseReview'] = args.license_review
        return download(candidate, cfg, root)
    if command == 'index':
        for asset in rows(root):
            check(sha(asset['path']) == asset['sha256'], 'CACHE_INVALID: check library before indexing')
        return semantic('index', cfg, cfg_path, root)
    if command == 'search':
        if args.provider in ['commons', 'nasa']:
            results = online_search(args.provider, args.query, args.limit)
        elif args.provider == 'semantic':
            response_data = semantic('search', cfg, cfg_path, root, args.query, args.limit)
            known = {str(Path(a['path']).resolve()).casefold(): a for a in rows(root)}
            results = []
            for hit in response_data.get('hits', []):
                asset = known.get(str(Path(hit['video_path']).resolve()).casefold())
                if asset:
                    results.append({**hit, 'assetId': asset['id'], 'origins': asset['origins'], 'reviewRequired': True})
        else:
            terms = args.query.casefold().split()
            results = [a for a in rows(root) if all(t in (a['title'] + ' ' + ' '.join(a['tags'])).casefold() for t in terms)]
            results = results[:args.limit]
        return {'provider': args.provider, 'query': args.query, 'candidates': results,
                'reviewRequired': True, 'noAutomaticAdoption': True}
    assets = rows(root)
    if command == 'list':
        return {'assets': assets}
    asset = next((x for x in assets if x['id'] == args.id), None)
    check(asset is not None, 'Unknown library asset ID')
    if command == 'verify':
        check(sha(asset['path']) == asset['sha256'], 'CACHE_INVALID: SHA mismatch')
        return {**asset, 'media': info(asset['path'], cfg), 'verified': True}
    return cut(asset, args, cfg, root)

def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', default=str(CONFIG))
    p.add_argument('--library-root')
    sub = p.add_subparsers(dest='command', required=True)
    for name in ['doctor', 'list', 'index']:
        sub.add_parser(name)
    s = sub.add_parser('search')
    s.add_argument('--provider', choices=['local', 'semantic', 'commons', 'nasa'], default='local')
    s.add_argument('--query', required=True)
    s.add_argument('--limit', type=int, choices=range(1, 11), default=6)
    i = sub.add_parser('import')
    i.add_argument('--input', required=True)
    i.add_argument('--origin', required=True)
    i.add_argument('--tags', nargs='*')
    d = sub.add_parser('download')
    d.add_argument('--page')
    d.add_argument('--input')
    d.add_argument('--id')
    d.add_argument('--license-review', required=True)
    v = sub.add_parser('verify')
    v.add_argument('--id', required=True)
    c = sub.add_parser('cut')
    for key in ['id', 'output', 'review-note']:
        c.add_argument('--' + key, required=True)
    c.add_argument('--start', required=True, type=float)
    c.add_argument('--end', required=True, type=float)
    c.add_argument('--fps', type=Fraction, default=30)
    c.add_argument('--width', type=int, default=1280)
    return p

if __name__ == '__main__':
    try:
        result = run(parser().parse_args())
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
