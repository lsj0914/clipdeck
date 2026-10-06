"""License receipt integrity: changed or missing texts cannot pass a bundle audit."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/packaging'))
from common import manifest


class NoticeTests(unittest.TestCase):
    def fixture(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        app = Path(tmp.name) / 'ClipDeck.app'
        resources = app / 'Contents/Resources'
        for directory in ['notices', 'app/dist/renderer/licenses', 'corresponding-source']:
            (resources / directory).mkdir(parents=True)
        (resources / 'notices/LICENSE').write_text('full upstream license', encoding='utf-8')
        (resources / 'app/dist/renderer/licenses/font.txt').write_text('full font license', encoding='utf-8')
        for name in ['application.tar.gz', 'media.tar.gz', 'decoder.tar.gz']:
            (resources / 'corresponding-source' / name).write_bytes(b'source companion')
        value = {'application_license': 'GPL-3.0-or-later', 'model_bundled': False, 'notices': manifest(resources / 'notices'), 'built_font_notices': manifest(resources / 'app/dist/renderer/licenses'), 'source_companions': manifest(resources / 'corresponding-source')}
        (resources / 'notices/inventory.json').write_text(json.dumps(value), encoding='utf-8')
        return app

    def invoke(self, app):
        self.assertTrue((ROOT / 'scripts/packaging/audit_notices.py').exists(), 'Notice auditor is not implemented')
        from audit_notices import audit_notices
        return audit_notices(app)

    def test_exact_full_text_inventory_passes(self):
        self.assertEqual(self.invoke(self.fixture())['errors'], [])

    def test_altered_full_license_text_is_rejected(self):
        app = self.fixture()
        (app / 'Contents/Resources/notices/LICENSE').write_text('shortened', encoding='utf-8')
        self.assertTrue(self.invoke(app)['errors'])

    def test_missing_corresponding_source_is_rejected(self):
        app = self.fixture()
        (app / 'Contents/Resources/corresponding-source/decoder.tar.gz').unlink()
        self.assertTrue(self.invoke(app)['errors'])


if __name__ == '__main__':
    unittest.main()
