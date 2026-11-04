#!/usr/bin/env python3
"""Build only the reviewed plugin files, with reproducible ZIP metadata."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
root = Path(__file__).resolve().parent.parent
subprocess.run(['node', str(root / 'scripts/validate.mjs')], check=True)
files = ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md',
         'assets/icon.png', 'mcp.json', 'plugin.json', 'skills/opencrawl/SKILL.md']
version = json.loads((root / 'opencrawl/plugin.json').read_text())['version']
out = root / 'dist'
out.mkdir(exist_ok=True)
archive = out / f'opencrawl-{version}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(files):
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, (root / 'opencrawl' / name).read_bytes())
with zipfile.ZipFile(archive) as z:
    assert sorted(z.namelist()) == sorted(files)
    assert z.testzip() is None
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / 'SHA256SUMS').write_text(f'{checksum}  {archive.name}\n')
print(f'{archive.name}: {checksum}')
