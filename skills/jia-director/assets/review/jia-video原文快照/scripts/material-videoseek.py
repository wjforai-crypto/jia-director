"""Process-isolated offline VideoSeek adapter; no GUI, cloud, resident service or second timeline."""
import argparse
import contextlib
import copy
import json
import os
import shutil
import sys
from pathlib import Path

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

def run(args):
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
    runtime = cfg['materials']['semantic']
    root = Path(args.library_root).resolve()
    data_root = root / 'index-data'
    os.environ.update(LOCALAPPDATA=str(data_root), HF_HOME=str(data_root / 'hf-cache'), HF_HUB_OFFLINE='1',
                      TRANSFORMERS_OFFLINE='1', VIDEOSEEK_INFERENCE_EP='cpu', VIDEOSEEK_AGENT_EXPORT_STRICT='1')
    sys.path.insert(0, runtime['sourceRoot'])
    from src.app.config import DEFAULT_CONFIG, CONFIG_FILE, build_data_storage_paths, load_config, save_config
    config_path = Path(CONFIG_FILE).resolve()
    if data_root not in config_path.parents:
        raise ValueError('Refusing to use default user VideoSeek configuration')
    if args.command == 'index':
        local = copy.deepcopy(DEFAULT_CONFIG)
        local.update(schema_version=2, models={'active_profile': '', 'profiles': []}, model_dir=runtime['modelsRoot'],
                     data_root=str(data_root / 'VideoSeek'), prefer_gpu=False, inference_ep='cpu', embedding_batch_size=4,
                     sampling_fps_mode='fixed', fps=1, indexing_video_workers=1, agent_api_enabled=False,
                     search_telemetry_enabled=False, text_search_enhance_enabled=False, frame_neighbor_rerank_enabled=False,
                     search_video_discovery_enabled=False, ffmpeg_path=shutil.which(cfg['tools']['ffmpegCommand']))
        local.update(build_data_storage_paths(local['data_root']))
        for profile in local['understanding']['profiles']:
            profile['enabled'] = False
        config_path.parent.mkdir(parents=True, exist_ok=True)
        if not config_path.exists():
            config_path.write_text(json.dumps(local, ensure_ascii=False), encoding='utf-8')
        from src.services.model_package_service import import_model_packages
        import_model_packages(runtime['modelsRoot'])
        local = load_config()
        local['models']['active_profile'] = 'chinese_clip_vit_base_patch16'
        for profile in local['models']['profiles']:
            profile['runtime']['prefer_gpu'] = False
        save_config(local)
        from src.services.library_service import add_library, register_library_videos
        library = str(root / 'files')
        if not Path(library).is_dir():
            raise ValueError('Import or download licensed library files before indexing')
        add_library(library)
        register_library_videos(config=local, library_path=library)
        from src.storage.asset_store import load_model_metadata, save_model_metadata
        from src.storage.video_identity import get_video_hash
        from src.services.indexing_service import scan_target_libraries
        meta = load_model_metadata(config=local)
        issues = []
        result = scan_target_libraries(meta, local, get_video_hash, target_lib=library,
                                       persist_meta_callback=lambda: save_model_metadata(meta, config=local),
                                       issue_callback=lambda *a, **k: issues.append(str(a)))
        save_model_metadata(meta, config=local)
        if issues or not result[1]:
            raise ValueError('Indexing incomplete: ' + str(issues) + ' ' + str(result))
        return {'kind': 'jia-video-local-semantic-index', 'library': library, 'result': result,
                'offline': True, 'reviewRequired': True, 'cloudProvidersUsed': []}
    if not config_path.exists():
        raise ValueError('Run materials index before semantic search')
    from src.web.agent_api.schemas import AgentSearchRequest, AgentSearchScope
    from src.web.agent_api.search import execute_agent_search
    request = AgentSearchRequest(query=args.query, query_type='text', mode='frame', top_k=args.limit,
                                 text_enhance=False, search_precision_mode='fast',
                                 scope=AgentSearchScope(library_paths=[str(root / 'files')]),
                                 expand_frame_hits=True, pad_before_sec=1.5, pad_after_sec=1.5)
    return execute_agent_search(request)

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['index', 'search'])
    p.add_argument('--config', required=True)
    p.add_argument('--library-root', required=True)
    p.add_argument('--query')
    p.add_argument('--limit', type=int, default=6)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = run(p.parse_args())
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
