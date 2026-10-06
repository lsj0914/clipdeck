#!/usr/bin/env python3
"""Freeze an explicitly reviewed dist and its matching application source archive."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

from common import PackagingError, manifest, safe_path, sha256, write_json

REPO = Path(__file__).resolve().parents[2]


def git(product: Path, *args: str) -> str:
    """Read source identity without editing git state."""
    result = subprocess.run(['git', '-C', str(product), *args], capture_output=True, text=True)
    if result.returncode:
        raise PackagingError(result.stderr)
    return result.stdout.strip()


def snapshot(product: Path, application_source: Path, output: Path) -> dict:
    """Bind built files and required source/license assets to a committed revision."""
    if output.exists():
        raise PackagingError('Choose a new snapshot filename')
    commit = git(product, 'rev-parse', 'HEAD')
    # A source archive produced with git archive --format=tar HEAD is checked
    # against every committed blob, not only its filename or a claimed commit.
    tree = subprocess.run(['git', '-C', str(product), 'ls-tree', '-rz', '--full-tree', commit], capture_output=True, check=True).stdout
    expected = {}
    for record in tree.split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, kind, oid = header.decode().split()
        if kind != 'blob':
            raise PackagingError('Submodules are unsupported in the application source archive')
        blob = subprocess.run(['git', '-C', str(product), 'cat-file', 'blob', oid], capture_output=True, check=True).stdout
        expected[name.decode()] = {'sha256': hashlib.sha256(blob).hexdigest(), 'mode': mode}
    for name in ('package.json', 'worker/transcribe.py', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'packaging/resources.lock.json', 'assets/branding/ClipDeck.icns'):
        if name not in expected:
            raise PackagingError(f'Required committed packaging input is missing: {name}')
    seen = set()
    with tarfile.open(application_source) as archive:
        for member in archive.getmembers():
            safe_path(member.name, product)
            if member.isdir():
                continue
            if member.name not in expected or member.name in seen:
                raise PackagingError(f'Unexpected or duplicate source path: {member.name}')
            row = expected[member.name]
            if row['mode'] == '120000':
                actual = hashlib.sha256(member.linkname.encode()).hexdigest() if member.issym() else None
            elif member.isfile():
                stream = archive.extractfile(member)
                actual = hashlib.sha256(stream.read()).hexdigest() if stream else None
                if bool(member.mode & 0o111) != (row['mode'] == '100755'):
                    raise PackagingError(f'Source executable mode differs: {member.name}')
            else:
                actual = None
            if actual != row['sha256']:
                raise PackagingError(f'Source archive differs from committed source: {member.name}')
            seen.add(member.name)
    if seen != set(expected):
        raise PackagingError('Application source archive omits committed files')
    for name, row in expected.items():
        path = product / name
        if row['mode'] == '120000':
            actual = hashlib.sha256(str(path.readlink()).encode()).hexdigest() if path.is_symlink() else None
        else:
            actual = sha256(path) if path.is_file() and not path.is_symlink() else None
        if actual != row['sha256'] or (row['mode'] != '120000' and bool(path.stat().st_mode & 0o111) != (row['mode'] == '100755')):
            raise PackagingError(f'Uncommitted packaged input: {name}')
    if not (product / 'dist/main/main.cjs').is_file() or not (product / 'dist/renderer/index.html').is_file():
        raise PackagingError('Build main/renderer entries are missing')
    value = {'schema': 1, 'source_commit': commit, 'dirty_context': git(product, 'status', '--short'), 'source_files': expected, 'package_sha256': sha256(product / 'package.json'), 'worker_sha256': sha256(product / 'worker/transcribe.py'), 'dist_files': manifest(product / 'dist'), 'application_source': {'file': application_source.name, 'sha256': sha256(application_source), 'bytes': application_source.stat().st_size}, 'build_and_review_authorization': 'Caller must first complete the reviewed coherent build; this tool does not infer it'}
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, value)
    return value


def main() -> int:
    """Write a new receipt after source and build integrity checks."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', type=Path, default=REPO)
    parser.add_argument('--application-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        value = snapshot(args.product.resolve(), args.application_source.resolve(), args.output)
        print(json.dumps({'source_commit': value['source_commit'], 'dist_files': len(value['dist_files']), 'snapshot': str(args.output)}))
    except (PackagingError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
