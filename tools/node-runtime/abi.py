"""Fail closed on ELF requirements above the official Node Linux ABI floor."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

LIMITS = {'GLIBC': (2, 28), 'GLIBCXX': (3, 4, 25), 'CXXABI': (1, 3, 11)}
LIBRARIES = {'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0',
             'libc.so.6', 'libdl.so.2', 'librt.so.1'}


def check_versions(text):
    # Read only version NEEDS. Version definitions on the executable are not
    # requirements imposed on a host's libc/libstdc++.
    needs = text.split('Version needs section', 1)
    if len(needs) != 2:
        raise ValueError('ELF has no version requirement evidence')
    names = re.findall(r'\bName: (\S+)', needs[1])
    if not names:
        raise ValueError('No ELF version requirements parsed')
    found = {}
    for name in names:
        match = re.fullmatch(r'(GLIBC|GLIBCXX|CXXABI)_([0-9]+(?:\.[0-9]+)+)', name)
        if not match:
            if name in {'GCC_3.0', 'GCC_3.3', 'GCC_4.2.0'}:
                continue
            raise ValueError('Unreviewed ELF version requirement: ' + name)
        family, version = match.groups()
        value = tuple(map(int, version.split('.')))
        if value > LIMITS[family]:
            raise ValueError('ELF exceeds official Node compatibility floor: ' + name)
        found[family] = max(found.get(family, ()), value)
    if 'GLIBC' not in found:
        raise ValueError('Missing libc requirement evidence')
    return {key: '.'.join(map(str, value)) for key, value in sorted(found.items())}


def inspect(path):
    path = pathlib.Path(path)
    versions = subprocess.check_output(['readelf', '--wide', '--version-info', str(path)], text=True)
    dynamic = subprocess.check_output(['readelf', '--wide', '--dynamic', str(path)], text=True)
    libraries = re.findall(r'\(NEEDED\).*\[(.*?)\]', dynamic)
    if not libraries or set(libraries) - LIBRARIES:
        raise ValueError('Unreviewed linked runtime library: ' + repr(libraries))
    if re.search(r'\((?:RPATH|RUNPATH)\)', dynamic):
        raise ValueError('Build-local runtime library search path')
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'requirements': check_versions(versions), 'libraries': sorted(libraries)}


def main():
    node, addon, output = sys.argv[1:]
    result = {'version': 1, 'limits': {key: '.'.join(map(str, value)) for key, value in LIMITS.items()},
              'node': inspect(node), 'nativeProbe': inspect(addon),
              'compiler': subprocess.check_output(['g++', '-dumpfullversion'], text=True).strip(),
              'buildLibc': subprocess.check_output(['getconf', 'GNU_LIBC_VERSION'], text=True).strip(),
              'buildDriver': subprocess.check_output(['ninja', '--version'], text=True).strip()}
    pathlib.Path(output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
