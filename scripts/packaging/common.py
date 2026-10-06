"""Fail-closed portable archive and inventory operations (standard library only)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
from typing import Any
import urllib.parse
import urllib.request
import zipfile


class PackagingError(ValueError):
    """An input does not satisfy a packaging boundary."""


def sha256(path: Path) -> str:
    """Hash a file without loading the entire runtime archive into memory."""
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    """Write UTF-8 evidence and check the saved value."""
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    if json.loads(path.read_text(encoding='utf-8')) != value:
        raise PackagingError(f'JSON read-back failed: {path}')


def verify_asset(path: Path, row: dict) -> None:
    """Require both the pinned archive identity and byte length."""
    if not path.is_file() or path.is_symlink():
        raise PackagingError(f'Regular asset required: {path.name}')
    if sha256(path) != row['sha256']:
        raise PackagingError(f'SHA-256 mismatch: {path.name}')
    if path.stat().st_size != row['bytes']:
        raise PackagingError(f'Byte-length mismatch: {path.name}')


def download_asset(url: str, path: Path, row: dict) -> None:
    """Download a pinned HTTPS asset to a new path, removing partial failures."""
    if urllib.parse.urlparse(url).scheme != 'https':
        raise PackagingError('Downloads require an explicit HTTPS release URL')
    if path.exists():
        verify_asset(path, row)
        return
    partial = path.with_suffix(path.suffix + '.partial')
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            if urllib.parse.urlparse(response.url).scheme != 'https':
                raise PackagingError('Download redirected outside HTTPS')
            with partial.open('xb') as output:
                for block in iter(lambda: response.read(1024 * 1024), b''):
                    output.write(block)
        verify_asset(partial, row)
        partial.rename(path)
    finally:
        partial.unlink(missing_ok=True)


def safe_path(name: str, root: Path) -> Path:
    """Reject absolute, traversing, ambiguous and empty archive paths."""
    value = PurePosixPath(name)
    if not name or value.is_absolute() or '..' in value.parts or '\\' in name or '\x00' in name or not value.parts:
        raise PackagingError(f'Unsafe archive path: {name!r}')
    return root.joinpath(*value.parts)


def inside(path: Path, root: Path) -> bool:
    """Test containment after following symlinks, including absent final paths."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def check_link(path: Path, target: str, root: Path) -> None:
    """Allow relative internal links but reject paths escaping their payload."""
    if not target or PurePosixPath(target).is_absolute() or '\\' in target or not inside(path.parent / target, root):
        raise PackagingError(f'Unsafe symlink: {path.name} -> {target}')


def check_parents(path: Path, root: Path) -> None:
    """Prevent writes through a previously created symlink directory."""
    parent = path.parent
    while parent != root:
        if parent.is_symlink():
            raise PackagingError(f'Unsafe symlink parent: {path}')
        parent = parent.parent


def extract_tar(archive_path: Path, root: Path, allowed_prefix: str) -> None:
    """Extract regular files/directories/internal symlinks, preserving modes."""
    prefix = PurePosixPath(allowed_prefix)
    seen: set[str] = set()
    with tarfile.open(archive_path, 'r:*') as archive:
        for member in archive.getmembers():
            path = safe_path(member.name, root)
            relative = PurePosixPath(member.name)
            ancestor_directory = member.isdir() and relative in prefix.parents
            if relative != prefix and prefix not in relative.parents and not ancestor_directory:
                raise PackagingError(f'Unexpected archive scope: {member.name}')
            if member.name in seen:
                raise PackagingError(f'Duplicate archive path: {member.name}')
            seen.add(member.name)
            check_parents(path, root)
            if member.mode & 0o7000:
                raise PackagingError(f'Privileged archive mode: {member.name}')
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(member.mode & 0o777)
            elif member.issym():
                check_link(path, member.linkname, root.joinpath(*prefix.parts))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(member.linkname)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                stream = archive.extractfile(member)
                if stream is None:
                    raise PackagingError(f'Missing archive content: {member.name}')
                with stream, path.open('xb') as output:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        output.write(block)
                path.chmod(member.mode & 0o777)
            else:
                raise PackagingError(f'Unsupported archive entry: {member.name}')
    for path in root.joinpath(*prefix.parts).rglob('*'):
        if path.is_symlink() and (not path.exists() or not inside(path, root.joinpath(*prefix.parts))):
            raise PackagingError(f'Broken or escaping symlink: {path}')


def extract_zip(archive_path: Path, root: Path) -> None:
    """Preserve the official Electron ZIP's executable modes and symlinks."""
    seen: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            path = safe_path(member.filename, root)
            if member.filename in seen:
                raise PackagingError(f'Duplicate archive path: {member.filename}')
            seen.add(member.filename)
            check_parents(path, root)
            mode = member.external_attr >> 16
            if mode & 0o7000:
                raise PackagingError(f'Privileged archive mode: {member.filename}')
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                path.chmod((mode & 0o777) or 0o755)
            elif stat.S_ISLNK(mode):
                target = archive.read(member).decode('utf-8')
                check_link(path, target, root)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(target)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as stream, path.open('xb') as output:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        output.write(block)
                path.chmod((mode & 0o777) or 0o644)
    for path in root.rglob('*'):
        if path.is_symlink() and (not path.exists() or not inside(path, root)):
            raise PackagingError(f'Broken or escaping ZIP symlink: {path}')


def manifest(root: Path, exclude: tuple[str, ...] = ()) -> list[dict]:
    """Inventory files and symlinks with relative names, hashes and modes."""
    rows = []
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name in exclude:
            continue
        if path.is_symlink():
            rows.append({'path': name, 'symlink': os.readlink(path)})
        elif path.is_file():
            rows.append({'path': name, 'sha256': sha256(path), 'bytes': path.stat().st_size, 'mode': oct(stat.S_IMODE(path.stat().st_mode))})
    return rows


def verify_manifest(root: Path, rows: list[dict], exclude: tuple[str, ...] = ()) -> None:
    """Reject missing, changed, additional files, modes or link targets."""
    if manifest(root, exclude) != rows:
        raise PackagingError('Payload manifest mismatch (files, modes or symlinks changed)')


def require_executable(path: Path) -> None:
    """Require a portable executable without consulting the developer PATH."""
    if not path.is_file() or path.is_symlink() or not path.stat().st_mode & 0o111:
        raise PackagingError(f'Executable required: {path}')
