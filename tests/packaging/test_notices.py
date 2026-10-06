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

    def punctuation_fixture(self):
        app = self.fixture()
        resources = app / 'Contents/Resources'
        model = resources / 'runtime/punctuation'
        model.mkdir(parents=True)
        (model / 'model_quant.onnx').write_bytes(b'pinned test weights')
        (model / 'tokens.json').write_text('["test"]', encoding='utf-8')
        notices = resources / 'notices/upstream/models'
        notices.mkdir(parents=True)
        for name in ['FunASR-LICENSE', 'CT-punctuation-model-card.md', 'CT-punctuation-Apache-2.0.txt', 'punctuation-provenance.json']:
            (notices / name).write_text('full retained test notice', encoding='utf-8')
        file = resources / 'notices/inventory.json'
        inventory = json.loads(file.read_text(encoding='utf-8'))
        inventory.update(model_bundled=True, asr_model_bundled=False, punctuation_model_bundled=True,
                         punctuation_files=manifest(model), notices=manifest(resources / 'notices', ('inventory.json',)))
        file.write_text(json.dumps(inventory), encoding='utf-8')
        return app

    def test_declared_punctuation_with_retained_full_notices_passes(self):
        self.assertEqual(self.invoke(self.punctuation_fixture())['errors'], [])

    def test_undeclared_or_altered_punctuation_is_rejected(self):
        app = self.fixture()
        (app / 'Contents/Resources/runtime/punctuation').mkdir(parents=True)
        self.assertIn('Undeclared punctuation model', self.invoke(app)['errors'])
        app = self.punctuation_fixture()
        (app / 'Contents/Resources/runtime/punctuation/model_quant.onnx').write_bytes(b'changed')
        self.assertTrue(self.invoke(app)['errors'])

    def test_missing_punctuation_notice_or_implicit_asr_is_rejected(self):
        app = self.punctuation_fixture()
        (app / 'Contents/Resources/notices/upstream/models/CT-punctuation-Apache-2.0.txt').unlink()
        self.assertTrue(self.invoke(app)['errors'])
        app = self.punctuation_fixture()
        file = app / 'Contents/Resources/notices/inventory.json'
        inventory = json.loads(file.read_text(encoding='utf-8'))
        inventory['asr_model_bundled'] = True
        file.write_text(json.dumps(inventory), encoding='utf-8')
        self.assertIn('Model implicitly bundled', self.invoke(app)['errors'])


if __name__ == '__main__':
    unittest.main()
