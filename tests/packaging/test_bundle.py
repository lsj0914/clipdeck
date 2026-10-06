"""Packaging behavior checked with real miniature bundles, not product builds."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/packaging'))
from common import PackagingError, extract_zip, manifest, verify_manifest


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_electron_zip_preserves_framework_links_and_executable_modes(self):
        archive = self.root / 'electron.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            executable = zipfile.ZipInfo('Electron.app/Contents/MacOS/Electron')
            executable.create_system = 3
            executable.external_attr = 0o100755 << 16
            zipped.writestr(executable, b'code')
            link = zipfile.ZipInfo('Electron.app/Contents/MacOS/current')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            zipped.writestr(link, 'Electron')
        output = self.root / 'unpacked'
        output.mkdir()
        extract_zip(archive, output)
        self.assertEqual((output / 'Electron.app/Contents/MacOS/current').readlink(), Path('Electron'))
        self.assertEqual((output / 'Electron.app/Contents/MacOS/Electron').stat().st_mode & 0o777, 0o755)

    def test_resource_manifest_detects_added_file_and_mode_changes(self):
        tree = self.root / 'runtime'
        tree.mkdir()
        binary = tree / 'python'
        binary.write_bytes(b'code')
        binary.chmod(0o755)
        rows = manifest(tree)
        binary.chmod(0o644)
        with self.assertRaisesRegex(PackagingError, 'manifest mismatch'):
            verify_manifest(tree, rows)
        binary.chmod(0o755)
        (tree / 'unexpected').write_bytes(b'extra')
        with self.assertRaisesRegex(PackagingError, 'manifest mismatch'):
            verify_manifest(tree, rows)

    def test_rebranding_supplies_missing_base_helper_resources_and_real_icon(self):
        script = ROOT / 'scripts/packaging/build_app.py'
        self.assertTrue(script.exists(), 'Public bundle assembly is not implemented')
        import build_app
        app = self.root / 'ClipDeck.app'
        for name in ['Electron', 'Electron Helper', 'Electron Helper (GPU)']:
            bundle = app if name == 'Electron' else app / 'Contents/Frameworks' / (name + '.app')
            (bundle / 'Contents/MacOS').mkdir(parents=True)
            (bundle / 'Contents/MacOS' / name).write_bytes(b'code')
            value = {'CFBundleExecutable': name, 'CFBundleName': name, 'CFBundleIdentifier': 'org.electronjs.Electron', 'ElectronAsarIntegrity': {'old': 'hash'}}
            (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(value))
        (app / 'Contents/Resources').mkdir()
        icon = self.root / 'authored.icns'
        icon.write_bytes(b'icon')
        build_app.rebrand_app(app, '0.1.0', icon)
        helper = app / 'Contents/Frameworks/ClipDeck Helper.app'
        self.assertTrue((helper / 'Contents/Resources').is_dir())
        self.assertTrue((helper / 'Contents/MacOS/ClipDeck Helper').exists())
        self.assertEqual((app / 'Contents/Resources/ClipDeck.icns').read_bytes(), b'icon')
        value = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        self.assertEqual(value['CFBundleIconFile'], 'ClipDeck.icns')
        self.assertEqual(value['LSMinimumSystemVersion'], '14.0')
        self.assertNotIn('ElectronAsarIntegrity', value)

    def test_media_asset_recipe_is_byte_reproducible_and_selects_only_cli(self):
        script = ROOT / 'scripts/packaging/create_media_asset.py'
        self.assertTrue(script.exists(), 'Media release-asset recipe is not implemented')
        binary = self.root / 'bin'
        binary.mkdir()
        for name in ['ffmpeg', 'ffprobe']:
            path = binary / name
            path.write_bytes(name.encode())
            path.chmod(0o755)
        (binary / 'obsolete-PyAV').write_bytes(b'not CLI')
        paths = [self.root / 'first.tar.gz', self.root / 'second.tar.gz']
        for path in paths:
            result = subprocess.run([sys.executable, str(script), '--bin-dir', str(binary), '--output', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(paths[0].read_bytes(), paths[1].read_bytes())
        import tarfile
        with tarfile.open(paths[0]) as archive:
            self.assertEqual(archive.getnames(), ['runtime/bin/ffmpeg', 'runtime/bin/ffprobe'])


if __name__ == '__main__':
    unittest.main()
