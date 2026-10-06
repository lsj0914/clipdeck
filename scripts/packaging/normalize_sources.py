#!/usr/bin/env python3
"""Normalize owned diagnostic paths in corresponding-source archives; never source inputs."""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile

from common import PackagingError, safe_path, sha256, write_json

PRIVATE_PATH = re.compile(r'/Users/|/home/|/var/folders/|/private/(?:tmp|var)/|(?:workspace/)?research/', re.I)


def digest(data: bytes) -> str:
    """Return a content identity for one retained archive member."""
    return hashlib.sha256(data).hexdigest()


def normalize(archive_path: Path, output: Path, role: str, original_sha256: str) -> dict:
    """Change only enumerated owned snapshots; preserve every original member/mode."""
    if output.exists() or output.is_symlink():
        raise PackagingError('Choose a new public archive path; original/public assets are preserved')
    if role not in ('media', 'decoder'):
        raise PackagingError('Unknown source role')
    if sha256(archive_path) != original_sha256:
        raise PackagingError('Original corresponding-source archive SHA-256 mismatch')
    root = '' if role == 'media' else 'clipdeck-maintained-decoder-source/'
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        payload = {}
        for member in members:
            safe_path(member.name, Path('/archive-root'))
            if member.name in payload:
                raise PackagingError('Duplicate source archive member')
            if not (member.isfile() or member.isdir() or member.issym()):
                raise PackagingError(f'Unsupported source archive entry: {member.name}')
            stream = archive.extractfile(member) if member.isfile() else None
            payload[member.name] = stream.read() if stream else None
            if member.issym() and PRIVATE_PATH.search(member.linkname):
                raise PackagingError(f'Unaccounted private path in symlink: {member.name}')
    original_manifest = json.loads(payload[root + 'source-manifest.json'])
    metadata = copy.deepcopy(original_manifest)
    upstream = []
    upstream_names = set()
    for row in original_manifest['sources']:
        name = row.get('file', row.get('filename'))
        if not name or Path(name).name != name:
            raise PackagingError('Upstream archive filename must be a basename')
        member_name = root + 'sources/' + name
        data = payload[member_name]
        if data is None or digest(data) != row['sha256']:
            raise PackagingError(f'Upstream source digest mismatch: {name}')
        upstream_names.add(member_name)
        upstream.append({'path': member_name, 'sha256': row['sha256'], 'bytes': len(data), 'unchanged': True})
    if len(upstream) != 3:
        raise PackagingError('Expected three pinned upstream source inputs for this companion')
    configuration_name = 'logs/ffmpeg-config.mak' if role == 'media' else root + 'decoder-provenance.json'
    configuration = payload[configuration_name].decode('utf-8')
    match = re.search(r'--prefix=([^\s\"\']+)', configuration)
    if match is None or not Path(match[1]).is_absolute():
        raise PackagingError('Owned absolute configure prefix was not found')
    prefix = match[1]
    token = '${CLIPDECK_MEDIA_PREFIX}' if role == 'media' else '${CLIPDECK_DECODER_PREFIX}'
    allowed = {'source-manifest.json', 'logs/ffmpeg-config.mak', 'logs/runtime-version.txt'} if role == 'media' else {
        root + 'source-manifest.json', root + 'decoder-provenance.json', root + 'actual-build-config/config.h', root + 'actual-build-config/config.mak'}
    transformed = dict(payload)
    transformations = {}
    if role == 'media':
        for row in metadata['system_library_dependencies']:
            if not row['architecture'].endswith('Mach-O 64-bit executable arm64'):
                raise PackagingError('Unexpected captured media architecture diagnostic')
            row['architecture'] = 'arm64'
        transformed['source-manifest.json'] = (json.dumps(metadata, indent=2) + '\n').encode()
        transformations['source-manifest.json'] = ['architecture capture becomes architecture value arm64; all other JSON values preserved']
        for name in ('logs/ffmpeg-config.mak', 'logs/runtime-version.txt'):
            transformed[name] = payload[name].replace(prefix.encode(), token.encode())
            transformations[name] = ['owned configure/include/link prefix becomes ' + token + '; all flags preserved']
    else:
        decoder_root = str(Path(prefix).parent)
        wheel = Path(metadata['wheel']['path'])
        try:
            metadata['wheel']['path'] = wheel.relative_to(decoder_root).as_posix()
        except ValueError as error:
            raise PackagingError('Captured wheel is outside the owned decoder build root') from error
        transformed[root + 'source-manifest.json'] = (json.dumps(metadata, indent=2) + '\n').encode()
        transformations[root + 'source-manifest.json'] = ['wheel.path becomes relative to owned decoder root; all source inputs/other JSON values preserved']
        provenance = json.loads(payload[root + 'decoder-provenance.json'])
        verification_roots = set()
        for row in provenance['libraries']:
            path = row['path']
            anchor = '/lib/python3.12/site-packages/av/'
            if anchor not in path:
                raise PackagingError('Unknown decoder verification path layout')
            verification_roots.add(path.split(anchor, 1)[0])
        if len(verification_roots) != 1:
            raise PackagingError('Expected one owned decoder verification installation')
        verification_root = next(iter(verification_roots))
        for name in (root + 'decoder-provenance.json', root + 'actual-build-config/config.h', root + 'actual-build-config/config.mak'):
            data = payload[name].replace(prefix.encode(), token.encode())
            data = data.replace(verification_root.encode(), b'${CLIPDECK_DECODER_VERIFY_ROOT}')
            data = data.replace(decoder_root.encode(), b'${CLIPDECK_DECODER_ROOT}')
            transformed[name] = data
            transformations[name] = ['owned prefix/root/verification installation becomes parameterized token; no flag, library digest, loader edge or source change']
    if metadata['sources'] != original_manifest['sources']:
        raise PackagingError('Source-manifest upstream input values changed')
    changed = []
    preserved = []
    for member in members:
        before, after = payload[member.name], transformed[member.name]
        if before != after:
            if member.name not in allowed:
                raise PackagingError('Unapproved source member transformation')
            changed.append({'path': member.name, 'original_sha256': digest(before), 'public_sha256': digest(after), 'transformations': transformations[member.name]})
        else:
            preserved.append({'path': member.name, 'type': 'file' if member.isfile() else 'directory' if member.isdir() else 'symlink', 'mode': oct(member.mode), **({'sha256': digest(before), 'bytes': len(before)} if before is not None else {}), **({'target': member.linkname} if member.issym() else {})})
        if member.name not in upstream_names and after is not None:
            try:
                text = after.decode('utf-8')
            except UnicodeDecodeError as error:
                raise PackagingError(f'Unaccounted non-text owned source member: {member.name}') from error
            if PRIVATE_PATH.search(text):
                raise PackagingError(f'Unaccounted private path in owned source text: {member.name}')
    receipt = {'schema': 1, 'role': role, 'original': {'file': archive_path.name, 'sha256': original_sha256, 'bytes': archive_path.stat().st_size}, 'changed_members': changed, 'preserved_members': preserved, 'upstream_sources': upstream, 'owned_private_path_scan_passed': True, 'outer_metadata_private_path_scan_passed': True, 'outer_header_normalization': 'uid/gid=0; uname/gname empty; timestamps=0; original names/types/modes/relative link targets retained', 'runtime_binaries_changed': False}
    documentation = '''# Public corresponding-source normalization

Only ClipDeck-owned diagnostic/provenance path fields and configure prefixes were parameterized. All upstream source archives, licenses, source patches, actual build flags, recipes, dependency/relinking inputs and member modes remain intact. The original private archive is preserved outside publication; its identity and every transformed/unchanged member are recorded in public-normalization.json.

Tokens: CLIPDECK_MEDIA_PREFIX denotes the media recipe's build-prefix directory; CLIPDECK_DECODER_PREFIX denotes the decoder recipe's prefix; CLIPDECK_DECODER_ROOT denotes that recipe root; CLIPDECK_DECODER_VERIFY_ROOT denotes the historical verification Python installation root (diagnostics only; no old virtual environment is shipped). Media architecture diagnostics are ARM64 values; decoder wheel.path is relative to the owned recipe root.

These parameterized files are captured build/verification snapshots, not new build flags or source patches. Run the unchanged build recipe to regenerate configuration under a chosen local root. If examining a captured snapshot, substitute these tokens with the equivalent local directories. Public outer archive headers use neutral owners and zero timestamps for repeatability; executable modes and links are retained. No source member was omitted.
'''.encode()
    extra = {root + 'PUBLIC-NORMALIZATION.md': documentation, root + 'public-normalization.json': (json.dumps(receipt, indent=2) + '\n').encode()}
    if set(extra) & set(payload):
        raise PackagingError('Normalization documents already exist in original input')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Own an exclusive staging namespace; never clean up the requested output.
    # Same-parent hard-link publication is atomic and refuses any existing file
    # or link, including one that appeared while this archive was being prepared.
    with tempfile.TemporaryDirectory(prefix='.' + output.name + '-preparing-', dir=output.parent) as directory:
        stage = Path(directory) / output.name
        with stage.open('xb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0, compresslevel=9) as compressed, tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for member in members:
                info = copy.copy(member)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                info.pax_headers = {key: value for key, value in member.pax_headers.items() if key not in ('atime', 'ctime', 'mtime', 'uid', 'gid', 'uname', 'gname')}
                data = transformed[member.name]
                if data is not None:
                    info.size = len(data)
                archive.addfile(info, io.BytesIO(data) if data is not None else None)
            for name, data in extra.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
        with tarfile.open(stage) as archive:
            actual = {member.name: member for member in archive.getmembers()}
            if set(actual) != set(payload) | set(extra):
                raise PackagingError('Public companion omitted/added an unaccounted source member')
            for final in actual.values():
                fields = [final.name, final.linkname, final.uname, final.gname, *final.pax_headers.keys(), *final.pax_headers.values()]
                if any(PRIVATE_PATH.search(str(value)) for value in fields):
                    raise PackagingError(f'Unaccounted private path in public archive metadata: {final.name}')
            for member in members:
                final = actual[member.name]
                if final.mode != member.mode or final.type != member.type or final.linkname != member.linkname:
                    raise PackagingError('Source mode/type/link changed')
                if member.isfile() and archive.extractfile(final).read() != transformed[member.name]:
                    raise PackagingError('Public source member read-back mismatch')
        receipt['public'] = {'file': output.name, 'sha256': sha256(stage), 'bytes': stage.stat().st_size}
        os.link(stage, output, follow_symlinks=False)
        return receipt


def main() -> int:
    """Produce a new public companion and separate transformation identity receipt."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('media', 'decoder'), required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--original-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.receipt.exists():
            raise PackagingError('Choose a new receipt path')
        value = normalize(args.input.resolve(), args.output, args.role, args.original_sha256)
        write_json(args.receipt, value)
        print(json.dumps({'public': value['public'], 'changed_members': len(value['changed_members']), 'upstream_sources': len(value['upstream_sources']), 'owned_private_path_scan_passed': True}))
    except (PackagingError, OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
