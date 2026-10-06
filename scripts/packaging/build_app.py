#!/usr/bin/env python3
"""Assemble a reviewed build into an ad-hoc signed ClipDeck.app preview on macOS."""
from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

from audit_app import audit, native
from common import PackagingError, extract_zip, manifest, sha256, verify_asset, verify_manifest, write_json

REPO = Path(__file__).resolve().parents[2]


def command(argv: list[str]) -> str:
    """Require success while preserving the command's diagnostic stderr."""
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode:
        raise PackagingError(f'{argv[0]} failed ({result.returncode}): {result.stdout}\n{result.stderr}')
    return result.stdout.strip()


def rebrand_app(app: Path, version: str, icon: Path) -> None:
    """Brand all helpers and the outer app without changing sandbox settings."""
    for helper in sorted((app / 'Contents/Frameworks').glob('Electron Helper*.app')):
        old = helper.stem
        new = old.replace('Electron', 'ClipDeck', 1)
        if old == 'Electron Helper':
            resources = helper / 'Contents/Resources'
            resources.mkdir(exist_ok=True)
            if resources.is_symlink() or not resources.is_dir():
                raise PackagingError('Base helper Resources must be a real directory')
            resources.chmod(0o755)
        plist = helper / 'Contents/Info.plist'
        value = plistlib.loads(plist.read_bytes())
        (helper / 'Contents/MacOS' / old).rename(helper / 'Contents/MacOS' / new)
        suffix = new[len('ClipDeck Helper'):].strip(' ()').lower()
        identifier = 'org.clipdeck.preview.helper' + ('.' + suffix if suffix else '')
        value.update(CFBundleExecutable=new, CFBundleName=new, CFBundleDisplayName=new, CFBundleIdentifier=identifier)
        plist.write_bytes(plistlib.dumps(value))
        helper.rename(helper.with_name(new + '.app'))
    plist = app / 'Contents/Info.plist'
    value = plistlib.loads(plist.read_bytes())
    (app / 'Contents/MacOS/Electron').rename(app / 'Contents/MacOS/ClipDeck')
    value.update(CFBundleExecutable='ClipDeck', CFBundleName='ClipDeck', CFBundleDisplayName='ClipDeck', CFBundleIdentifier='org.clipdeck.preview', CFBundleShortVersionString=version, CFBundleVersion=version, LSMinimumSystemVersion='14.0', LSApplicationCategoryType='public.app-category.video', CFBundleIconFile='ClipDeck.icns')
    value.pop('ElectronAsarIntegrity', None)
    plist.write_bytes(plistlib.dumps(value))
    shutil.copy2(icon, app / 'Contents/Resources/ClipDeck.icns')
    old_icon = app / 'Contents/Resources/electron.icns'
    old_icon.unlink(missing_ok=True)


def add_notices(product: Path, electron: Path, resources: Path, package: dict) -> dict:
    """Retain full licenses, matching sources and an exact notice hash inventory."""
    notices = resources / 'notices'
    shutil.copy2(product / 'LICENSE', notices / 'ClipDeck-GPL-3.0.txt')
    shutil.copy2(product / 'THIRD_PARTY_NOTICES.md', notices / 'THIRD_PARTY_NOTICES.md')
    shutil.copy2(electron / 'LICENSE', notices / 'Electron-LICENSE')
    shutil.copy2(electron / 'LICENSES.chromium.html', notices / 'Electron-LICENSES.chromium.html')
    for path in sorted((product / 'packaging/notices').rglob('*')):
        if path.is_file():
            relative = path.relative_to(product / 'packaging/notices')
            target = notices / 'upstream' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    frontend = []
    resolved = json.loads((product / 'package-lock.json').read_text(encoding='utf-8'))['packages']
    fonts = sorted(name for name in package['dependencies'] if name.startswith('@fontsource-variable/'))
    if fonts != ['@fontsource-variable/instrument-sans', '@fontsource-variable/jetbrains-mono', '@fontsource-variable/noto-sans-sc']:
        raise PackagingError('Font dependency set changed: update reviewed notices before packaging')
    for name in ['react', 'react-dom', 'scheduler', '@tanstack/react-virtual', '@tanstack/virtual-core', *fonts]:
        directory = product / 'node_modules' / name
        metadata = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        if metadata['version'] != resolved['node_modules/' + name]['version']:
            raise PackagingError(f'Installed notice version differs from lock: {name}')
        license_path = next((path for path in directory.iterdir() if path.name.lower() in ('license', 'license.txt', 'license.md')), None)
        if license_path is None:
            raise PackagingError(f'Missing license: {name}')
        if name in fonts and metadata['version'] != '5.3.0':
            raise PackagingError(f'Unreviewed font version: {name}')
        target = notices / ('js-' + name.replace('/', '-').replace('@', '') + '-LICENSE')
        shutil.copy2(license_path, target)
        frontend.append({'name': name, 'version': metadata['version'], 'license': metadata.get('license'), 'path': target.relative_to(resources).as_posix(), 'sha256': sha256(target)})
    font_notices = resources / 'app/dist/renderer/licenses'
    for name in ('Instrument-Sans-OFL.txt', 'Noto-Sans-SC-OFL.txt', 'Noto-Sans-SC-Upstream-OFL.txt', 'JetBrains-Mono-OFL.txt'):
        if not (font_notices / name).is_file():
            raise PackagingError(f'Missing built font notice: {name}')
    if any('IBM' in path.name for path in font_notices.iterdir()):
        raise PackagingError('Obsolete font notice in reviewed build')
    # Verify every separately retained worker license against its pinned inventory.
    worker_inventory = json.loads((notices / 'worker-license-inventory.json').read_text(encoding='utf-8'))
    rows = list(worker_inventory['base_and_supplemental_license_files'])
    for distribution in worker_inventory['distributions']:
        rows.extend(distribution['retained_files'])
    for row in rows:
        if sha256(resources / 'runtime/worker' / row['path']) != row['sha256']:
            raise PackagingError(f'Worker license changed: {row["path"]}')
    return {'schema': 1, 'application_license': 'GPL-3.0-or-later', 'frontend': frontend, 'worker_license_inventory': 'notices/worker-license-inventory.json', 'model_bundled': True, 'asr_model_bundled': False, 'punctuation_model_bundled': True, 'punctuation_files': manifest(resources / 'runtime/punctuation'), 'notices': manifest(notices), 'built_font_notices': manifest(font_notices), 'source_companions': manifest(resources / 'corresponding-source')}


def sign_inside_out(app: Path, receipt: Path) -> list[dict]:
    """Sign native leaves, nested bundles deepest first, then the outer app."""
    rows = []
    paths = sorted(path for path in app.rglob('*') if native(path))
    nested = sorted((path for path in app.rglob('*') if path.is_dir() and not path.is_symlink() and path.suffix in ('.app', '.framework')), key=lambda path: (len(path.parts), str(path)), reverse=True)
    for path, kind in [*((path, 'native') for path in paths), *((path, 'bundle') for path in nested), (app, 'outer app')]:
        result = subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(path)], capture_output=True, text=True)
        rows.append({'path': path.relative_to(app).as_posix(), 'kind': kind, 'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        write_json(receipt, rows)
        if result.returncode:
            raise PackagingError(f'Signing failed for {path}: {result.stderr}')
    return rows


def build(product: Path, resources_input: Path, electron_zip: Path, snapshot: Path, application_source: Path, output: Path) -> dict:
    """Copy immutable inputs into a new output; never rebuild or alter the checkout."""
    if output.exists() or output.is_symlink():
        raise PackagingError('Choose a new output directory; artifacts are never overwritten')
    lock = json.loads((product / 'packaging/resources.lock.json').read_text(encoding='utf-8'))
    verify_asset(electron_zip, lock['electron'])
    frozen = json.loads(snapshot.read_text(encoding='utf-8'))
    if frozen['source_commit'] != command(['git', '-C', str(product), 'rev-parse', 'HEAD']):
        raise PackagingError('Source commit differs from the reviewed build snapshot')
    if frozen['package_sha256'] != sha256(product / 'package.json') or frozen['worker_sha256'] != sha256(product / 'worker/transcribe.py'):
        raise PackagingError('Package or worker changed since snapshot')
    verify_manifest(product / 'dist', frozen['dist_files'])
    for name, row in frozen['source_files'].items():
        path = product / name
        actual = hashlib.sha256(str(path.readlink()).encode()).hexdigest() if row['mode'] == '120000' and path.is_symlink() else sha256(path) if path.is_file() and not path.is_symlink() else None
        if actual != row['sha256'] or (row['mode'] != '120000' and bool(path.stat().st_mode & 0o111) != (row['mode'] == '100755')):
            raise PackagingError(f'Source input changed since snapshot: {name}')
    if sha256(application_source) != frozen['application_source']['sha256']:
        raise PackagingError('Application corresponding-source archive differs from snapshot')
    prepared = json.loads((resources_input / 'resource-manifest.json').read_text(encoding='utf-8'))
    if prepared['layout'] != 'resources' or prepared['lock_sha256'] != sha256(product / 'packaging/resources.lock.json'):
        raise PackagingError('Prepared resources do not match the current lock/resources layout')
    verify_manifest(resources_input, prepared['files'], ('resource-manifest.json',))
    package = json.loads((product / 'package.json').read_text(encoding='utf-8'))
    output.mkdir(parents=True)
    try:
        extracted = output / 'electron-input'
        extracted.mkdir()
        extract_zip(electron_zip, extracted)
        app = output / 'ClipDeck.app'
        shutil.copytree(extracted / 'Electron.app', app, symlinks=True)
        resources = app / 'Contents/Resources'
        (resources / 'default_app.asar').unlink(missing_ok=True)
        for path in resources_input.iterdir():
            if path.name != 'resource-manifest.json':
                if path.is_dir():
                    shutil.copytree(path, resources / path.name, symlinks=True)
                else:
                    shutil.copy2(path, resources / path.name)
        appcode = resources / 'app'
        appcode.mkdir()
        shutil.copytree(product / 'dist', appcode / 'dist', symlinks=True, ignore=shutil.ignore_patterns('*.map'))
        write_json(appcode / 'package.json', {'name': 'clipdeck', 'productName': 'ClipDeck', 'version': package['version'], 'private': True, 'main': 'dist/main/main.cjs', 'type': 'module'})
        (resources / 'worker').mkdir()
        shutil.copy2(product / 'worker/transcribe.py', resources / 'worker/transcribe.py')
        shutil.copy2(product / 'worker/punctuation.py', resources / 'worker/punctuation.py')
        shutil.copy2(application_source, resources / 'corresponding-source' / application_source.name)
        rebrand_app(app, package['version'], product / 'assets/branding/ClipDeck.icns')
        notice_inventory = add_notices(product, extracted, resources, package)
        write_json(resources / 'notices/inventory.json', notice_inventory)
        verify_manifest(product / 'dist', frozen['dist_files'])
        for row in frozen['dist_files']:
            if row['path'].endswith('.map'):
                continue
            target = appcode / 'dist' / row['path']
            if 'symlink' in row:
                if str(target.readlink()) != row['symlink']:
                    raise PackagingError('Copied build symlink changed')
            elif sha256(target) != row['sha256']:
                raise PackagingError('Copied build file changed')
        if sha256(resources / 'worker/transcribe.py') != frozen['worker_sha256']:
            raise PackagingError('Worker changed while copying')
        if sha256(resources / 'worker/punctuation.py') != frozen['source_files']['worker/punctuation.py']['sha256']:
            raise PackagingError('Punctuation worker changed while copying')
        sign_inside_out(app, output / 'signing.json')
        result = audit(app)
        write_json(output / 'native-audit.json', result)
        if result['errors'] or not result['bundle_strict_deep_signature_verified']:
            raise PackagingError('Native/signature audit failed; inspect native-audit.json')
        write_json(output / 'sha256-manifest.json', {'schema': 1, 'files': manifest(app), 'directories': [{'path': path.relative_to(app).as_posix(), 'mode': oct(path.stat().st_mode & 0o777)} for path in sorted(app.rglob('*')) if path.is_dir() and not path.is_symlink()]})
        receipt = {'schema': 1, 'status': 'ad-hoc preview; final workflow acceptance remains separate', 'created_at': datetime.now(timezone.utc).isoformat(), 'version': package['version'], 'source_commit': frozen['source_commit'], 'dirty_context_at_snapshot': frozen['dirty_context'], 'snapshot_sha256': sha256(snapshot), 'electron_archive': lock['electron'], 'resource_lock_sha256': prepared['lock_sha256'], 'native_count': result['native_count'], 'highest_binary_minos': result['highest_binary_minos'], 'architecture': 'arm64', 'bundle_minimum_macos': '14.0', 'developer_id_signed': False, 'notarized': False, 'oldest_os_execution_verified': False, 'model_bundled': True, 'asr_model_bundled': False, 'punctuation_model_bundled': True, 'R15_full_workflow_accepted': False}
        write_json(output / 'preparation.json', receipt)
        # Preserve archive identity via the lock/receipt; extracted duplicates are
        # an intermediate, not part of the downloadable app or source payload.
        shutil.rmtree(extracted)
        return receipt
    except (PackagingError, OSError, ValueError) as error:
        write_json(output / 'failure.json', {'error': str(error), 'inputs_preserved': True})
        raise


def main() -> int:
    """Package only explicitly frozen inputs into a new preview artifact."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', type=Path, default=REPO)
    parser.add_argument('--resources', type=Path, required=True)
    parser.add_argument('--electron-zip', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--application-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = build(args.product.resolve(), args.resources.resolve(), args.electron_zip.resolve(), args.snapshot.resolve(), args.application_source.resolve(), args.output.absolute())
        print(json.dumps(result, indent=2))
    except (PackagingError, OSError, ValueError, KeyError) as error:
        print(f'Packaging failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
