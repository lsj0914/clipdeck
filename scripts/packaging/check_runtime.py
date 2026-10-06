#!/usr/bin/env python3
"""One real portable worker mode-check under macOS outbound network denial."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from common import PackagingError, require_executable, sha256, write_json


def check(runtime: Path, worker: Path, output: Path) -> dict:
    """Preflight without a model, developer PATH, package installation or inference."""
    if output.exists():
        raise PackagingError('Choose a new receipt path')
    python = runtime / 'worker/bin/python3.12'
    require_executable(python)
    with tempfile.TemporaryDirectory(prefix='clipdeck-preflight-') as temporary:
        home = Path(temporary)
        hf = home / 'empty-hf'
        hf.mkdir()
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'HF_HOME': str(hf), 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'ORT_DISABLE_TELEMETRY': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': str(home)}
        policy = '(version 1)(allow default)(deny network-outbound)'
        argv = ['/usr/bin/sandbox-exec', '-p', policy, str(python), '-I', '-B', str(worker)]
        result = subprocess.run(argv, input=json.dumps({'mode': 'check'}) + '\n', env=env, capture_output=True, text=True, timeout=120)
        value = {'schema': 1, 'python_sha256': sha256(python), 'worker_sha256': sha256(worker), 'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr, 'worker_os_outbound_denial': policy, 'PATH': env['PATH'], 'hf_cache_empty': not any(hf.iterdir()), 'model_used': False, 'full_app_offline_validation': False}
        output.parent.mkdir(parents=True, exist_ok=True)
        write_json(output, value)
        try:
            rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        except json.JSONDecodeError as error:
            raise PackagingError('Worker emitted malformed JSON; inspect saved receipt') from error
        if result.returncode or len(rows) != 1 or rows[0].get('type') != 'ready' or not value['hf_cache_empty']:
            raise PackagingError('Real worker preflight failed; inspect saved stdout/stderr')
        return value


def main() -> int:
    """Accept developer runtime root or the packaged Resources/runtime root."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--worker-script', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        value = check(args.runtime_dir.resolve(), args.worker_script.resolve(), args.output)
        print(json.dumps({'worker_ready': True, 'receipt': str(args.output), 'full_app_offline_validation': False}))
    except (PackagingError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
