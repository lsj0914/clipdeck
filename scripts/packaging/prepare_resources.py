#!/usr/bin/env python3
"""Prepare verified portable resources without installing Python or changing PATH."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.parse

from common import PackagingError, download_asset, extract_tar, manifest, require_executable, safe_path, sha256, verify_asset, verify_manifest, write_json

DEFAULT_LOCK = Path(__file__).resolve().parents[2] / 'packaging/resources.lock.json'
ROLES = ('worker', 'media', 'punctuation', 'media_source', 'decoder_source')


def prepare(lock_path: Path, assets_dir: Path, output: Path, layout: str, release_url: str | None = None) -> dict:
    """Materialize a new tree only after every pinned asset verifies."""
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise PackagingError('Choose a new output directory; existing files are preserved')
    lock = json.loads(lock_path.read_text(encoding='utf-8'))
    if lock['schema'] != 1:
        raise PackagingError('Unsupported resource lock schema')
    assets_dir.mkdir(parents=True, exist_ok=True)
    for role in ROLES:
        row = lock['assets'][role]
        if Path(row['file']).name != row['file']:
            raise PackagingError('Asset names must be basenames')
        path = assets_dir / row['file']
        if release_url:
            download_asset(release_url.rstrip('/') + '/' + urllib.parse.quote(row['file']), path, row)
        verify_asset(path, row)
    for row in lock.get('metadata', []):
        verify_asset(safe_path(row['file'], lock_path.parent), row)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.' + output.name + '-preparing-', dir=output.parent))
    try:
        extract_tar(assets_dir / lock['assets']['worker']['file'], stage, 'runtime/worker')
        extract_tar(assets_dir / lock['assets']['media']['file'], stage, 'runtime/bin')
        extract_tar(assets_dir / lock['assets']['punctuation']['file'], stage, 'runtime/punctuation')
        for name in ('runtime/worker/bin/python3.12', 'runtime/bin/ffmpeg', 'runtime/bin/ffprobe'):
            require_executable(stage / name)
        worker_manifest = lock.get('worker_manifest')
        if worker_manifest:
            rows = json.loads((lock_path.parent / worker_manifest).read_text(encoding='utf-8'))['files']
            verify_manifest(stage / 'runtime/worker', rows)
        (stage / 'notices').mkdir()
        for row in lock.get('metadata', []):
            relative = Path(row['file'])
            target = stage / 'notices' / ('upstream' if relative.parts[0] == 'notices' else '')
            target = target.joinpath(*relative.parts[1:]) if relative.parts[0] == 'notices' else target / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_path(row['file'], lock_path.parent), target)
            verify_asset(target, row)
        sources = stage / 'corresponding-source'
        sources.mkdir()
        for role in ('media_source', 'decoder_source'):
            name = lock['assets'][role]['file']
            shutil.copy2(assets_dir / name, sources / name)
        if layout == 'developer':
            runtime = stage / 'runtime'
            for entry in list(runtime.iterdir()):
                entry.rename(stage / entry.name)
            runtime.rmdir()
        receipt = {'schema': 1, 'layout': layout, 'lock_sha256': sha256(lock_path), 'assets': {role: lock['assets'][role] for role in ROLES}, 'files': manifest(stage), 'standalone_python': True, 'model_bundled': True, 'asr_model_bundled': False, 'punctuation_model_bundled': True}
        write_json(stage / 'resource-manifest.json', receipt)
        stage.rename(output)
        return receipt
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main() -> int:
    """Prepare local assets or download from an explicitly chosen release."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=DEFAULT_LOCK)
    parser.add_argument('--assets-dir', type=Path, required=True)
    parser.add_argument('--release-base-url', help='HTTPS release download directory; no implicit latest version')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--layout', choices=('resources', 'developer'), default='resources')
    args = parser.parse_args()
    try:
        result = prepare(args.lock.resolve(), args.assets_dir.resolve(), args.output, args.layout, args.release_base_url)
    except (PackagingError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f'Resource preparation failed: {error}', file=sys.stderr)
        return 1
    print(json.dumps({'output': str(args.output), 'files': len(result['files']), 'layout': args.layout, 'model_bundled': result['model_bundled'], 'asr_model_bundled': False, 'punctuation_model_bundled': True}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
