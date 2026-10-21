import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from fractions import Fraction

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('material_library', ROOT / 'skill-src/jia-video/scripts/material-library.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='jia-material-')
        self.root = Path(self.temp.name)
        self.library = self.root / 'library'
        self.cfg = json.loads((ROOT / 'config/video-workflow.json').read_text(encoding='utf-8'))
        self.source = self.root / 'input.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-n', str(self.source)], check=True)
        self.origin = {'provider': 'own', 'title': 'Procedural integration fixture',
                       'sourcePage': str(self.source), 'license': 'test-fixture-owned', 'author': 'Jia-video test'}

    def tearDown(self):
        self.temp.cleanup()

    def add(self):
        return module.register(self.source, self.origin, ['fixture'], self.cfg, self.library)

    def test_dedup_reuses_verified_bytes_and_preserves_multiple_origins(self):
        first = self.add()
        other = {**self.origin, 'sourcePage': 'local-fixture-second-origin'}
        second = module.register(self.source, other, ['second'], self.cfg, self.library)
        self.assertEqual(first['sha256'], second['sha256'])
        self.assertTrue(second['cacheReused'])
        self.assertEqual(len(module.rows(self.library)), 1)
        self.assertEqual(len(second['origins']), 2)

    def test_nonempty_corrupt_cache_is_rejected_without_overwrite(self):
        asset = self.add()
        Path(asset['path']).write_bytes(b'nonempty damaged cache')
        with self.assertRaisesRegex(ValueError, 'CACHE_INVALID'):
            self.add()
        self.assertEqual(Path(asset['path']).read_bytes(), b'nonempty damaged cache')

    def test_selected_source_interval_has_correct_duration_and_muted_audio(self):
        asset = self.add()
        args = SimpleNamespace(review_note='test fixture frame continuity', output=str(self.root/'cut.mp4'),
                               start=.5, end=1.5, fps=30, width=160)
        clip = module.cut(asset, args, self.cfg, self.library)
        self.assertAlmostEqual(clip['media']['duration'], 1, places=2)
        self.assertEqual(clip['media']['audioStreams'], 0)
        self.assertEqual(clip['sourceIn'], .5)
        self.assertEqual(clip['sourceSha256'], module.sha(self.source))
        self.assertTrue(Path(args.output + '.asset.json').is_file())
        with self.assertRaisesRegex(ValueError, 'new MP4'):
            module.cut(asset, args, self.cfg, self.library)

    def test_no_invented_rights_no_indexed_root_exports_and_no_nan_ranges(self):
        with self.assertRaisesRegex(ValueError, 'Origin requires'):
            module.register(self.source, {'title': 'missing license'}, [], self.cfg, self.library)
        asset = self.add()
        args = SimpleNamespace(review_note='fixture', output=str(self.library/'files/cut.mp4'), start=0, end=1, fps=30, width=160)
        with self.assertRaisesRegex(ValueError, 'indexed'):
            module.cut(asset, args, self.cfg, self.library)
        args.output = str(self.root/'cut.mp4')
        args.start = float('nan')
        with self.assertRaisesRegex(ValueError, 'Invalid source interval'):
            module.cut(asset, args, self.cfg, self.library)

    def test_fractional_parent_frame_rate_is_preserved(self):
        asset = self.add()
        args = SimpleNamespace(review_note='fractional CFR fixture', output=str(self.root/'fractional.mp4'),
                               start=.5, end=1.5, fps=Fraction('24000/1001'), width=160)
        clip = module.cut(asset, args, self.cfg, self.library)
        self.assertEqual(clip['media']['fps'], '24000/1001')
        self.assertLess(abs(clip['media']['duration'] - 1), .05)

    def test_only_public_selected_provider_hosts_are_allowed(self):
        for url in ['http://assets.mixkit.co/file', 'https://127.0.0.1/file', 'https://assets.mixkit.co:444/file', 'https://user:pass@assets.mixkit.co/file']:
            with self.assertRaises(ValueError):
                module.approved_url(url)

if __name__ == '__main__':
    unittest.main()
