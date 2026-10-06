"""Public source companions preserve upstream inputs and only normalize owned paths."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/packaging'))


class SourceNormalizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def fixture(self, role, unexpected=False):
        root = '' if role == 'media' else 'clipdeck-maintained-decoder-source/'
        prefix = '/Users/private-owner/workspace/research/build/' + ('build-prefix' if role == 'media' else 'prefix')
        configuration = '--prefix=' + prefix + ' --disable-network --enable-protocol=file,pipe --extra-cflags="-mmacosx-version-min=14.0 -I' + prefix + '/include"'
        sources, files = [], {}
        for name in ['FFmpeg', 'codec', 'pkgconf']:
            filename = name + '.tar.xz'
            data = b'preserved upstream archive bytes /Users/upstream-example'
            sources.append({'name': name, 'file' if role == 'media' else 'filename': filename, 'sha256': hashlib.sha256(data).hexdigest()})
            files[root + 'sources/' + filename] = data
        metadata = {'sources': sources}
        if role == 'media':
            metadata['system_library_dependencies'] = [{'architecture': '/Users/private-owner/workspace/research/verify/ffmpeg: Mach-O 64-bit executable arm64', 'sha256': 'binary-unchanged'}]
            files['logs/ffmpeg-config.mak'] = ('FFMPEG_CONFIGURATION=' + configuration + '\nprefix=' + prefix + '\n').encode()
            files['logs/runtime-version.txt'] = ('configuration: ' + configuration + '\n').encode()
        else:
            metadata['wheel'] = {'path': str(Path(prefix).parent / 'relocated-wheels/decoder.whl'), 'sha256': 'wheel-unchanged'}
            files[root + 'actual-build-config/config.h'] = ('#define FFMPEG_CONFIGURATION "' + configuration + '"\n').encode()
            files[root + 'actual-build-config/config.mak'] = ('prefix=' + prefix + '\n').encode()
            files[root + 'decoder-provenance.json'] = json.dumps({'actual_configuration': configuration, 'libraries': [{'path': '/Users/private-owner/workspace/research/verify-python/lib/python3.12/site-packages/av/_core.so', 'sha256': 'library-unchanged'}]}).encode()
        files[root + 'source-manifest.json'] = json.dumps(metadata).encode()
        files[root + 'build-' + role + '.sh'] = b'#!/bin/sh\n# original rebuild recipe\n'
        files[root + 'source.patch'] = b'exact source modification'
        files[root + 'LICENSE'] = b'exact license text'
        if unexpected:
            files[root + 'unexpected.txt'] = b'private path /Users/unknown-owner/private/file'
        archive = self.root / (role + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o755 if name.endswith('.sh') else 0o644
                info.uname = 'private-owner'
                tar.addfile(info, io.BytesIO(data))
        return archive, files, prefix

    def invoke(self, archive, role, output):
        self.assertTrue((ROOT / 'scripts/packaging/normalize_sources.py').exists(), 'Source normalization is not implemented')
        from normalize_sources import normalize
        return normalize(archive, output, role, hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_media_flags_upstream_inputs_modes_and_original_bytes_are_preserved(self):
        archive, originals, prefix = self.fixture('media')
        original_bytes = archive.read_bytes()
        output = self.root / 'public-media.tar.gz'
        receipt = self.invoke(archive, 'media', output)
        with tarfile.open(output) as tar:
            for name, data in originals.items():
                actual = tar.extractfile(name).read()
                if name.startswith('logs/'):
                    self.assertEqual(actual, data.replace(prefix.encode(), b'${CLIPDECK_MEDIA_PREFIX}'))
                elif name == 'source-manifest.json':
                    metadata = json.loads(actual)
                    self.assertEqual(metadata['system_library_dependencies'][0]['architecture'], 'arm64')
                    self.assertEqual(metadata['sources'], json.loads(data)['sources'])
                else:
                    self.assertEqual(actual, data)
                self.assertEqual(tar.getmember(name).uname, '')
            self.assertEqual(tar.getmember('build-media.sh').mode, 0o755)
        self.assertEqual(archive.read_bytes(), original_bytes)
        self.assertEqual(len(receipt['upstream_sources']), 3)
        self.assertTrue(receipt['owned_private_path_scan_passed'])
        twin = self.root / 'public-media-twin.tar.gz'
        self.invoke(archive, 'media', twin)
        self.assertEqual(output.read_bytes(), twin.read_bytes())

    def test_decoder_paths_are_parameterized_without_changing_inputs_or_relink_data(self):
        archive, originals, prefix = self.fixture('decoder')
        output = self.root / 'public-decoder.tar.gz'
        receipt = self.invoke(archive, 'decoder', output)
        root = 'clipdeck-maintained-decoder-source/'
        with tarfile.open(output) as tar:
            metadata = json.load(tar.extractfile(root + 'source-manifest.json'))
            self.assertEqual(metadata['wheel']['path'], 'relocated-wheels/decoder.whl')
            self.assertEqual(metadata['sources'], json.loads(originals[root + 'source-manifest.json'])['sources'])
            configuration = tar.extractfile(root + 'actual-build-config/config.h').read()
            self.assertEqual(configuration, originals[root + 'actual-build-config/config.h'].replace(prefix.encode(), b'${CLIPDECK_DECODER_PREFIX}'))
            for name in ['source.patch', 'LICENSE', 'build-decoder.sh']:
                self.assertEqual(tar.extractfile(root + name).read(), originals[root + name])
        self.assertEqual(len(receipt['upstream_sources']), 3)
        self.assertTrue(receipt['owned_private_path_scan_passed'])

    def test_unaccounted_private_path_fails_closed_and_preserves_input(self):
        archive, _, _ = self.fixture('media', unexpected=True)
        before = archive.read_bytes()
        output = self.root / 'should-not-exist.tar.gz'
        from common import PackagingError
        with self.assertRaisesRegex(PackagingError, 'Unaccounted private path'):
            self.invoke(archive, 'media', output)
        self.assertEqual(archive.read_bytes(), before)
        self.assertFalse(output.exists())

    def test_creation_collision_preserves_other_owner_file_or_link(self):
        archive, _, _ = self.fixture('media')
        original_bytes = archive.read_bytes()
        real_open, real_link = Path.open, os.link
        for kind in ('file', 'symlink'):
            with self.subTest(kind=kind):
                output = self.root / ('public-collision-' + kind + '.tar.gz')

                def collide():
                    if kind == 'file':
                        output.write_bytes(b'another invocation owns these bytes')
                    else:
                        output.symlink_to('other-owner-missing-target')

                def contested_open(path, mode='r', *args, **kwargs):
                    if path == output and mode == 'xb':
                        collide()
                    return real_open(path, mode, *args, **kwargs)

                def contested_link(source, destination, *args, **kwargs):
                    if Path(destination) == output:
                        collide()
                    return real_link(source, destination, *args, **kwargs)

                # Inject creation at the publication boundary, then use the real
                # exclusive filesystem primitive; no completed output is mocked.
                with patch.object(Path, 'open', contested_open), patch('os.link', contested_link):
                    with self.assertRaises(FileExistsError):
                        self.invoke(archive, 'media', output)
                if kind == 'file':
                    self.assertTrue(output.is_file(), 'Another owner output was deleted')
                    self.assertEqual(output.read_bytes(), b'another invocation owns these bytes')
                else:
                    self.assertTrue(output.is_symlink(), 'Another owner link was deleted')
                    self.assertEqual(os.readlink(output), 'other-owner-missing-target')
                self.assertEqual(archive.read_bytes(), original_bytes)
                self.assertFalse(list(self.root.glob('.' + output.name + '-preparing-*')))

    def test_preexisting_dangling_output_link_is_preserved(self):
        from common import PackagingError
        archive, _, _ = self.fixture('media')
        output = self.root / 'existing-link.tar.gz'
        output.symlink_to('missing-target')
        with self.assertRaises((PackagingError, FileExistsError)):
            self.invoke(archive, 'media', output)
        self.assertTrue(output.is_symlink(), 'Preexisting dangling output link was deleted')
        self.assertEqual(os.readlink(output), 'missing-target')

    def test_invocation_owned_partial_staging_is_cleaned_on_write_failure(self):
        archive, _, _ = self.fixture('media')
        original_bytes = archive.read_bytes()
        output = self.root / 'partial-write.tar.gz'
        real_addfile = tarfile.TarFile.addfile

        def fail_after_real_write(tar, *args, **kwargs):
            real_addfile(tar, *args, **kwargs)
            raise OSError('Injected failure after an actual partial archive write')

        with patch.object(tarfile.TarFile, 'addfile', fail_after_real_write):
            with self.assertRaisesRegex(OSError, 'actual partial archive write'):
                self.invoke(archive, 'media', output)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob('.' + output.name + '-preparing-*')))
        self.assertEqual(archive.read_bytes(), original_bytes)


if __name__ == '__main__':
    unittest.main()
