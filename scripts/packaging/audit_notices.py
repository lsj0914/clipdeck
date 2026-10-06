#!/usr/bin/env python3
"""Read-only verification of full notice texts, fonts and corresponding sources."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from common import PackagingError, verify_manifest, write_json


def audit_notices(app: Path) -> dict:
    """Check retained inventories; this does not replace a license review."""
    resources = app / 'Contents/Resources'
    inventory = json.loads((resources / 'notices/inventory.json').read_text(encoding='utf-8'))
    errors = []
    for directory, key, exclude in [('notices', 'notices', ('inventory.json',)), ('app/dist/renderer/licenses', 'built_font_notices', ()), ('corresponding-source', 'source_companions', ())]:
        try:
            verify_manifest(resources / directory, inventory[key], exclude)
        except PackagingError as error:
            errors.append(f'{directory}: {error}')
    if inventory['application_license'] != 'GPL-3.0-or-later':
        errors.append('Unreviewed application license')
    if (resources / 'runtime/punctuation').exists() and not inventory['model_bundled']:
        errors.append('Undeclared punctuation model')
    if inventory['model_bundled']:
        if inventory.get('asr_model_bundled') is not False or inventory.get('punctuation_model_bundled') is not True:
            errors.append('Model implicitly bundled')
        else:
            try:
                verify_manifest(resources / 'runtime/punctuation', inventory['punctuation_files'])
                for name in ('FunASR-LICENSE', 'CT-punctuation-model-card.md', 'CT-punctuation-Apache-2.0.txt', 'punctuation-provenance.json'):
                    if not (resources / 'notices/upstream/models' / name).is_file():
                        errors.append('Missing punctuation model notice: ' + name)
            except (PackagingError, KeyError) as error:
                errors.append('Punctuation resources: ' + str(error))
    if len(inventory['source_companions']) != 3:
        errors.append('Require application, media and maintained decoder source archives')
    return {'schema': 1, 'notice_file_count': len(inventory['notices']), 'font_notice_count': len(inventory['built_font_notices']), 'source_companion_count': len(inventory['source_companions']), 'errors': errors}


def main() -> int:
    """Write a compact immutable receipt without changing bundle contents."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = audit_notices(args.app.resolve())
        if args.output.exists():
            raise PackagingError('Choose a new receipt filename')
        write_json(args.output, result)
        print(json.dumps(result))
        return int(bool(result['errors']))
    except (PackagingError, OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
