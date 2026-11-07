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
            if name in {'GCC_3.0', 'GCC_3.3', 'GCC_3.4', 'GCC_4.2.0'}:
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


LOADERS = {62: ('x64', '/lib64/ld-linux-x86-64.so.2'),
           183: ('arm64', '/lib/ld-linux-aarch64.so.1')}


def elf_layout(header, programs, dynamic, executable=True):
    if len(header) != 20 or header[:7] != b'\x7fELF\x02\x01\x01':
        raise ValueError('Only native ELF64 little-endian v1 is reviewed')
    kind = int.from_bytes(header[16:18], 'little')
    machine = int.from_bytes(header[18:20], 'little')
    if kind not in (2, 3) or (not executable and kind != 3) or machine not in LOADERS:
        raise ValueError('Unreviewed ELF type or architecture')
    architecture, loader = LOADERS[machine]
    interpreters = re.findall(r'\[Requesting program interpreter: ([^\]]+)\]', programs)
    if interpreters != ([loader] if executable else []):
        raise ValueError('ELF interpreter does not match reviewed architecture')
    libraries = re.findall(r'\(NEEDED\).*\[(.*?)\]', dynamic)
    # glibc's own architecture-specific loader can be a DT_NEEDED entry.
    # Do not accept an opposite-architecture loader or arbitrary loader path.
    if not libraries or len(libraries) != len(set(libraries)) or set(libraries) - (LIBRARIES | {loader.rsplit('/', 1)[1]}):
        raise ValueError('Unreviewed linked runtime library: ' + repr(libraries))
    if re.search(r'\((?:RPATH|RUNPATH)\)', dynamic):
        raise ValueError('Build-local runtime library search path')
    return {'architecture': architecture, 'interpreter': loader if executable else None,
            'libraries': sorted(libraries)}


def inspect(path, executable=True):
    path = pathlib.Path(path)
    versions = subprocess.check_output(['readelf', '--wide', '--version-info', str(path)], text=True)
    dynamic = subprocess.check_output(['readelf', '--wide', '--dynamic', str(path)], text=True)
    programs = subprocess.check_output(['readelf', '--wide', '--program-headers', str(path)], text=True)
    with path.open('rb') as stream:
        header = stream.read(20)
    layout = elf_layout(header, programs, dynamic, executable)
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'requirements': check_versions(versions), **layout}


def main():
    node, addon, output = sys.argv[1:]
    node_proof, addon_proof = inspect(node), inspect(addon, executable=False)
    if node_proof['architecture'] != addon_proof['architecture']:
        raise ValueError('Node and native probe architectures differ')
    result = {'version': 1, 'limits': {key: '.'.join(map(str, value)) for key, value in LIMITS.items()},
              'node': node_proof, 'nativeProbe': addon_proof,
              'compiler': subprocess.check_output(['g++', '-dumpfullversion'], text=True).strip(),
              'buildLibc': subprocess.check_output(['getconf', 'GNU_LIBC_VERSION'], text=True).strip(),
              'buildDriver': subprocess.check_output(['ninja', '--version'], text=True).strip()}
    pathlib.Path(output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
