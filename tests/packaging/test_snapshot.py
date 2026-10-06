"""A release snapshot must bind the source archive to the actual checkout."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/packaging'))
from common import PackagingError
from snapshot_build import snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.product = self.root / 'product'
        self.product.mkdir()
        files = {'package.json': '{}', 'worker/transcribe.py': 'worker', 'LICENSE': 'license', 'src/renderer.ts': 'reviewed source', 'THIRD_PARTY_NOTICES.md': 'notices', 'packaging/resources.lock.json': '{}', 'assets/branding/ClipDeck.icns': 'icon'}
        for name, contents in files.items():
            path = self.product / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding='utf-8')
        for argv in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Packaging Test', '-c', 'user.email=packaging-test@invalid.local', 'commit', '-qm', 'fixture']]:
            subprocess.run(['git', '-C', str(self.product), *argv], check=True, capture_output=True)
        self.archive = self.root / 'source.tar.gz'
        with self.archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(self.product), 'archive', '--format=tar.gz', 'HEAD'], stdout=stream, check=True)
        for name in ('main/main.cjs', 'renderer/index.html'):
            path = self.product / 'dist' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('built', encoding='utf-8')
        self.output = self.root / 'snapshot.json'

    def test_matching_committed_source_and_dist_are_frozen(self):
        value = snapshot(self.product, self.archive, self.output)
        self.assertEqual(len(value['dist_files']), 2)
        self.assertTrue(self.output.exists())

    def test_uncommitted_renderer_cannot_be_paired_with_old_source_archive(self):
        (self.product / 'src/renderer.ts').write_text('unreviewed source', encoding='utf-8')
        with self.assertRaisesRegex(PackagingError, 'Uncommitted packaged input'):
            snapshot(self.product, self.archive, self.output)
        self.assertFalse(self.output.exists())

    def test_uncommitted_executable_mode_cannot_be_hidden_by_same_file_hash(self):
        (self.product / 'worker/transcribe.py').chmod(0o755)
        with self.assertRaisesRegex(PackagingError, 'Uncommitted packaged input'):
            snapshot(self.product, self.archive, self.output)

    def test_packaged_license_cannot_be_absent_from_the_committed_source(self):
        subprocess.run(['git', '-C', str(self.product), 'rm', '-q', 'LICENSE'], check=True)
        subprocess.run(['git', '-C', str(self.product), '-c', 'user.name=Packaging Test', '-c', 'user.email=packaging-test@invalid.local', 'commit', '-qm', 'missing license'], check=True)
        with self.archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(self.product), 'archive', '--format=tar.gz', 'HEAD'], stdout=stream, check=True)
        with self.assertRaisesRegex(PackagingError, 'Required committed packaging input'):
            snapshot(self.product, self.archive, self.output)

    def test_source_archive_with_missing_file_is_rejected(self):
        import tarfile
        incomplete = self.root / 'incomplete.tar.gz'
        with tarfile.open(self.archive) as original, tarfile.open(incomplete, 'w:gz') as destination:
            for member in original.getmembers():
                if member.name != 'src/renderer.ts':
                    destination.addfile(member, original.extractfile(member) if member.isfile() else None)
        with self.assertRaisesRegex(PackagingError, 'omits committed files'):
            snapshot(self.product, incomplete, self.output)


if __name__ == '__main__':
    unittest.main()
