"""Compatibility launcher for the single implementation in the Jia-video author package."""
import importlib.util
import json
import runpy
import sys
from pathlib import Path

workspace = Path(__file__).resolve().parent.parent
configuration = json.loads((workspace / 'config/video-workflow.json').read_text(encoding='utf-8-sig'))
IMPLEMENTATION = Path(configuration['materials']['launcher'])
if IMPLEMENTATION.resolve() == Path(__file__).resolve():
    IMPLEMENTATION = workspace / 'skill-src/jia-video/scripts/material-library.py'
sys.dont_write_bytecode = True
if __name__ == '__main__':
    runpy.run_path(str(IMPLEMENTATION), run_name='__main__')
else:
    spec = importlib.util.spec_from_file_location('jia_material_implementation', IMPLEMENTATION)
    implementation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(implementation)

    def __getattr__(name):
        return getattr(implementation, name)
