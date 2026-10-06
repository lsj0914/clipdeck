#!/usr/bin/env python3
"""Create the portable CLI asset deterministically from reviewed ffmpeg/ffprobe."""
from __future__ import annotations

import argparse
import gzip
from pathlib import Path
import sys
import tarfile

from common import PackagingError, require_executable, sha256


def create(bin_dir: Path, output: Path) -> dict:
    """Select only the two media CLIs, preserving their executable bytes/modes."""
    if output.exists():
        raise PackagingError('Choose a new asset path; do not overwrite release inputs')
    for name in ('ffmpeg', 'ffprobe'):
        require_executable(bin_dir / name)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0, compresslevel=9) as compressed, tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name in ('ffmpeg', 'ffprobe'):
            path = bin_dir / name
            info = tarfile.TarInfo('runtime/bin/' + name)
            info.size = path.stat().st_size
            info.mode = path.stat().st_mode & 0o777
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with path.open('rb') as contents:
                archive.addfile(info, contents)
    return {'file': output.name, 'sha256': sha256(output), 'bytes': output.stat().st_size}


def main() -> int:
    """Emit an immutable asset identity for a maintainer to review and pin."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        import json
        print(json.dumps(create(args.bin_dir.resolve(), args.output)))
    except (PackagingError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
