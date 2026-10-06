"""Archive-boundary tests: fail closed before files reach a runtime tree."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/packaging/prepare_resources.py'


class ResourcePreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()

    def archive(self, name, members):
        path = self.assets / name
        with tarfile.open(path, 'w:gz') as archive:
            for member_name, contents, mode in members:
                info = tarfile.TarInfo(member_name)
                info.mode = mode
                if contents is None:
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                elif isinstance(contents, tuple):
                    info.type = tarfile.SYMTYPE
                    info.linkname = contents[0]
                    archive.addfile(info)
                else:
                    info.size = len(contents)
                    archive.addfile(info, io.BytesIO(contents))
        return {'file': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}

    def inputs(self, worker=None):
        rows = {
            'worker': self.archive('worker.tar.gz', worker or [
                ('runtime/worker/bin/python3.12', b'portable python', 0o755),
                ('runtime/worker/bin/python3', ('python3.12',), 0o777)]),
            'media': self.archive('media.tar.gz', [('runtime/bin/ffmpeg', b'ffmpeg', 0o755), ('runtime/bin/ffprobe', b'ffprobe', 0o755)]),
            'punctuation': self.archive('punctuation.tar.gz', [('runtime/punctuation/model_quant.onnx', b'pinned model', 0o644), ('runtime/punctuation/tokens.json', b'tokens', 0o644)]),
            'media_source': self.archive('media-source.tar.gz', [('source/build.sh', b'source', 0o755)]),
            'decoder_source': self.archive('decoder-source.tar.gz', [('source/build.sh', b'decoder', 0o755)])}
        lock = self.root / 'lock.json'
        lock.write_text(json.dumps({'schema': 1, 'assets': rows, 'metadata': []}), encoding='utf-8')
        return lock

    def invoke(self, lock, output=None, *extra):
        self.assertTrue(SCRIPT.exists(), 'Public resource preparation is not implemented')
        return subprocess.run([sys.executable, str(SCRIPT), '--lock', str(lock), '--assets-dir', str(self.assets), '--output', str(output or self.root / 'Prepared With Spaces'), *extra], capture_output=True, text=True)

    def test_verified_inputs_preserve_executable_mode_and_relative_symlink(self):
        result = self.invoke(self.inputs())
        self.assertEqual(result.returncode, 0, result.stderr)
        out = self.root / 'Prepared With Spaces'
        self.assertEqual((out / 'runtime/worker/bin/python3').readlink(), Path('python3.12'))
        self.assertEqual((out / 'runtime/bin/ffmpeg').stat().st_mode & 0o777, 0o755)
        self.assertTrue((out / 'corresponding-source/media-source.tar.gz').exists())
        manifest = json.loads((out / 'resource-manifest.json').read_text())
        self.assertEqual(len(manifest['files']), 8)
        self.assertFalse(manifest['asr_model_bundled'])
        self.assertTrue(manifest['punctuation_model_bundled'])

    def test_standard_archive_parent_directories_are_allowed_without_broadening_file_scope(self):
        lock = self.inputs([('runtime', None, 0o755), ('runtime/worker', None, 0o755), ('runtime/worker/bin/python3.12', b'portable python', 0o755)])
        result = self.invoke(lock)
        self.assertEqual(result.returncode, 0, result.stderr)
        bad = self.inputs([('runtime/not-worker', b'wrong scope', 0o644)])
        result = self.invoke(bad, self.root / 'bad-output')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unexpected archive scope', result.stderr)

    def test_upstream_metadata_keeps_directory_identity_when_basenames_match(self):
        lock = self.inputs()
        value = json.loads(lock.read_text())
        for name, data in [('notices/media/LICENSE', b'GPL'), ('notices/decoder/LICENSE', b'LGPL')]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            value['metadata'].append({'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        lock.write_text(json.dumps(value), encoding='utf-8')
        result = self.invoke(lock)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'Prepared With Spaces/notices/upstream'
        self.assertTrue((output / 'media/LICENSE').is_file(), 'Media notice was flattened or overwritten')
        self.assertEqual((output / 'media/LICENSE').read_bytes(), b'GPL')
        self.assertEqual((output / 'decoder/LICENSE').read_bytes(), b'LGPL')

    def test_changed_asset_is_rejected_without_output(self):
        lock = self.inputs()
        (self.assets / 'worker.tar.gz').write_bytes(b'tampered')
        result = self.invoke(lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA-256 mismatch', result.stderr)
        self.assertFalse((self.root / 'Prepared With Spaces').exists())

    def test_archive_path_traversal_is_rejected(self):
        lock = self.inputs([('../escaped', b'bad', 0o644)])
        result = self.invoke(lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unsafe archive path', result.stderr)
        self.assertFalse((self.root / 'escaped').exists())

    def test_symlink_parent_cannot_redirect_later_archive_write(self):
        lock = self.inputs([('runtime/worker/bin', ('../../../../outside',), 0o777), ('runtime/worker/bin/owned', b'bad', 0o644)])
        result = self.invoke(lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unsafe symlink', result.stderr)
        self.assertFalse((self.root / 'outside').exists())

    def test_non_executable_runtime_is_rejected(self):
        lock = self.inputs([('runtime/worker/bin/python3.12', b'python', 0o644)])
        result = self.invoke(lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Executable required', result.stderr)

    def test_existing_output_is_preserved(self):
        output = self.root / 'existing'
        output.mkdir()
        (output / 'keep').write_text('valuable', encoding='utf-8')
        result = self.invoke(self.inputs(), output)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((output / 'keep').read_text(), 'valuable')

    def test_developer_layout_matches_current_runtime_resolver(self):
        result = self.invoke(self.inputs(), None, '--layout', 'developer')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = self.root / 'Prepared With Spaces'
        self.assertTrue((out / 'worker/bin/python3.12').exists())
        self.assertTrue((out / 'bin/ffmpeg').exists())
        self.assertTrue((out / 'punctuation/model_quant.onnx').exists())
        self.assertFalse((out / 'runtime').exists())


if __name__ == '__main__':
    unittest.main()
