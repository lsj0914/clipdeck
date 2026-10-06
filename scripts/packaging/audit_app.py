"""Read-only Mach-O, dependency, plist and strict-signature inventory."""
from __future__ import annotations

import argparse, hashlib, json, os, plistlib, re, stat, subprocess, sys
from common import PackagingError, write_json
from pathlib import Path

MAGIC = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xce', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}
def run(*args: str) -> subprocess.CompletedProcess:
    """Run a read-only inspection command and retain its diagnostics."""
    return subprocess.run(args, capture_output=True, text=True)
def sha(p: Path) -> str:
    """Return a file SHA-256 without loading the whole file into memory."""
    h=hashlib.sha256()
    with p.open('rb') as s:
        for b in iter(lambda:s.read(1048576), b''):h.update(b)
    return h.hexdigest()
def native(p: Path) -> bool:
    """Identify regular native files from their Mach-O magic bytes."""
    if p.is_symlink() or not p.is_file():return False
    with p.open('rb') as s:return s.read(4) in MAGIC
def load(p: Path) -> dict:
    """Parse loader commands without modifying or renaming the file."""
    # otool-classic interprets a filename ending '(GPU)' as archive(member).
    # An inherited read-only file descriptor avoids renaming any input.
    with p.open('rb') as stream:
        r=subprocess.run(['/usr/bin/otool','-l',f'/dev/fd/{stream.fileno()}'],capture_output=True,text=True,pass_fds=(stream.fileno(),))
    if r.returncode:
        raise PackagingError(f"otool failed for {p}: {r.stderr}")
    out={'dependencies':[], 'rpaths':[], 'minos':[], 'dylib_id':None}
    for block in re.split(r'(?=Load command \d+)',r.stdout):
        cmd=re.search(r'\n\s*cmd (\S+)',block)
        if not cmd:continue
        k=cmd[1]
        if k in ['LC_LOAD_DYLIB','LC_LOAD_WEAK_DYLIB','LC_REEXPORT_DYLIB','LC_LOAD_UPWARD_DYLIB','LC_ID_DYLIB']:
            name=re.search(r'\n\s*name (.*?) \(offset \d+\)',block)[1]
            if k=='LC_ID_DYLIB':out['dylib_id']=name
            else:out['dependencies'].append({'name':name,'load_command':k})
        elif k=='LC_RPATH':out['rpaths'].append(re.search(r'\n\s*path (.*?) \(offset \d+\)',block)[1])
        elif k=='LC_BUILD_VERSION':out['minos'].append(re.search(r'\n\s*minos ([\d.]+)',block)[1])
        elif k=='LC_VERSION_MIN_MACOSX':out['minos'].append(re.search(r'\n\s*version ([\d.]+)',block)[1])
    out['minos']=sorted(set(out['minos']))
    return out
def expand(v: str, origin: Path, executable: Path) -> Path:
    """Expand a loader token in its executable and file context."""
    if v=='@loader_path':return origin.parent
    if v=='@executable_path':return executable.parent
    if v.startswith('@loader_path/'):return origin.parent/v[len('@loader_path/'):]
    if v.startswith('@executable_path/'):return executable.parent/v[len('@executable_path/'):]
    return Path(v)
def audit(root: Path) -> dict:
    """Inspect every native file, dependency edge, plist and signature."""
    root=root.resolve(); paths=sorted(p for p in root.rglob('*') if native(p)); parsed={p:load(p) for p in paths}
    main=next((p for p in paths if p.parent==root/'Contents/MacOS'),None)
    if main is None:
        raise PackagingError("Missing main executable in Contents/MacOS")
    py=root/'Contents/Resources/runtime/worker/bin/python3.12'
    rows=[];errors=[];symlinks=[];plists=[]
    helper_resources=root/'Contents/Frameworks/ClipDeck Helper.app/Contents/Resources'
    if not helper_resources.is_dir() or helper_resources.is_symlink() or stat.S_IMODE(helper_resources.stat().st_mode)!=0o755:
        errors.append('Base ClipDeck helper Resources must exist as a real 0755 directory')
    for p in root.rglob('*'):
        if p.is_symlink():
            symlinks.append({'path':str(p.relative_to(root)),'target':str(p.readlink()),'inside_bundle':p.resolve().is_relative_to(root),'exists':p.exists()})
            if not p.resolve().is_relative_to(root) or not p.exists():errors.append(f'Invalid symlink: {p}')
        if p.name=='Info.plist' and not p.is_symlink():
            v=plistlib.loads(p.read_bytes());plists.append({'path':str(p.relative_to(root)),**{k:v[k] for k in ['CFBundleName','CFBundleIdentifier','CFBundleExecutable','CFBundleVersion','LSMinimumSystemVersion'] if k in v}})
    for p in paths:
        d=parsed[p];exe=main
        if p.is_relative_to(root/'Contents/Resources/runtime/worker'):exe=py
        for parent in p.parents:
            if parent.suffix=='.app' and parent!=root:
                plist=parent/'Contents/Info.plist'
                if plist.exists():
                    executable_name=plistlib.loads(plist.read_bytes()).get('CFBundleExecutable')
                    if executable_name:exe=parent/'Contents/MacOS'/executable_name
                break
        candidates=[expand(v,p,exe) for v in d['rpaths']]+[expand(v,exe,exe) for v in parsed.get(exe,{}).get('rpaths',[])]
        # Electron framework inherits the launch executable's runpaths; nested
        # native framework edges may additionally inherit their framework caller.
        if exe==main or exe!=py:
            candidates += [expand(v,main,exe) for v in parsed[main]['rpaths']]
        for dep in d['dependencies']:
            n=dep['name']
            if n.startswith(('/usr/lib/','/System/Library/')):dep['scope']='Apple system';continue
            targets=[c/n[len('@rpath/'):] for c in candidates] if n.startswith('@rpath/') else [expand(n,p,exe)]
            target=next((c.resolve() for c in targets if c.is_file()),None)
            if target and target.is_relative_to(root):dep.update(scope='bundled',resolved=str(target.relative_to(root)))
            else:errors.append(f'Unresolved non-system edge {p.relative_to(root)} -> {n}');dep['scope']='unresolved'
        arch=run('/usr/bin/lipo','-archs',str(p)).stdout.strip().split()
        sig=run('/usr/bin/codesign','--verify','--strict',str(p))
        detail=run('/usr/bin/codesign','-dvv',str(p)).stderr
        if arch!=['arm64']:errors.append(f'Architecture {p}: {arch}')
        if sig.returncode:errors.append(f'Signature {p}: {sig.stderr}')
        if d['dylib_id'] and d['dylib_id'].startswith('/') and not d['dylib_id'].startswith(('/System/Library/','/usr/lib/')):errors.append(f'Absolute non-system ID: {p}')
        for v in d['rpaths']:
            if v.startswith('/') and not v.startswith(('/System/Library/','/usr/lib/')):errors.append(f'Absolute non-system rpath: {p}')
        if not d['minos']:errors.append(f'Missing macOS deployment metadata: {p}')
        rows.append({'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':sha(p),'architectures':arch,'strict_signature_verified':sig.returncode==0,'signature_detail':detail,**d})
    bundle_sig=run('/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',str(root))
    if bundle_sig.returncode:errors.append('Outer bundle strict/deep signature failed')
    if len(rows)!=108:errors.append(f'Expected exactly 108 ARM64 native files, got {len(rows)}')
    if any(tuple(map(int,v.split('.')))>(14,0) for row in rows for v in row['minos']):errors.append('Mach-O minimum OS exceeds macOS 14')
    return {'root':str(root),'native_count':len(rows),'highest_binary_minos':max((v for r in rows for v in r['minos']),key=lambda v:tuple(map(int,v.split('.')))),'plists':plists,'native_files':rows,'symlinks':symlinks,'errors':errors,'bundle_strict_deep_signature_verified':bundle_sig.returncode==0,'bundle_signature_detail':bundle_sig.stderr,'oldest_os_execution_verified':False}
if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args=parser.parse_args()
    try:
        if args.output.exists():
            raise PackagingError('Choose a new receipt filename')
        result=audit(args.app)
        write_json(args.output,result)
        print(json.dumps({k:result[k] for k in ['native_count','highest_binary_minos','errors','bundle_strict_deep_signature_verified']}))
        sys.exit(bool(result['errors']))
    except (PackagingError, OSError, ValueError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
