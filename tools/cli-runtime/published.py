#!/usr/bin/env python3
"""Inspect an integrity-checked published CLI in a disposable native Linux runner.

No install, product authentication, capture hooks, gzip-file invocation or
publication. Registry metadata is retained as provenance, not a signature.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request

VERSION = '0.4.13'
ZLIB = '12731092979c6d07f42da27da673a9f6c7b13586'
LIMIT = 100 * 1024 * 1024
INTEGRITY = {
    'x64': 'sha512-XL8x7Wme5fAcD1wC2Yrkkg8UxYF3x5CJYiYGHW/VVrsTRO55Ov+1yz+vKsjpMcUeV2P4ci3StyY5KW7SzGPpYA==',
    'arm64': 'sha512-m5G7MgPonJDD7Yl0aU5tfNMRh5POen7kcisYq5Oy308Sr5rxtXKWmPwsdnRfSbXAa5Xipsh3smzj/zwCWPjOlw==',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read(url, limit):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'registry.npmjs.org'
            or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment or parsed.query):
        raise ValueError('Only exact public npm registry resources are permitted')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=60) as response:
        body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Registry response exceeds bound')
    return body


def inspect(architecture, output):
    machine = {'x64': 'x86_64', 'arm64': 'aarch64'}[architecture]
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or platform.system() != 'Linux' or platform.machine() != machine):
        raise ValueError('A matching disposable native GitHub runner is required')
    if output.exists():
        raise ValueError('Never overwrite a retained observation')
    package = '@getopencrawl/cli-linux-' + architecture
    metadata_url = 'https://registry.npmjs.org/' + urllib.parse.quote(package, safe='') + '/' + VERSION
    metadata_bytes = read(metadata_url, 1024 * 1024)
    metadata = json.loads(metadata_bytes)
    if (metadata.get('name') != package or metadata.get('version') != VERSION
            or metadata.get('os') != ['linux'] or metadata.get('cpu') != [architecture]):
        raise ValueError('Published package identity differs')
    expected_url = 'https://registry.npmjs.org/' + package + '/-/cli-linux-' + architecture + '-' + VERSION + '.tgz'
    if (metadata['dist']['tarball'] != expected_url
            or metadata['dist']['integrity'] != INTEGRITY[architecture]):
        raise ValueError('Exact published tarball identity required')
    archive = read(expected_url, LIMIT)
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if integrity != metadata['dist']['integrity']:
        raise ValueError('Published npm integrity mismatch')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar:
            if (member.name not in {'package/package.json', 'package/README.md', 'package/bin/opencrawl'}
                    or not member.isfile() or member.name in files or not 0 < member.size <= LIMIT):
                raise ValueError('Unexpected CLI archive member')
            files[member.name] = tar.extractfile(member).read(member.size + 1)
            if len(files[member.name]) != member.size:
                raise ValueError('CLI archive member size differs')
            if sum(len(value) for value in files.values()) > LIMIT:
                raise ValueError('Expanded CLI archive exceeds bound')
    if set(files) != {'package/package.json', 'package/README.md', 'package/bin/opencrawl'}:
        raise ValueError('Incomplete CLI archive')
    manifest = json.loads(files['package/package.json'])
    if manifest.get('name') != package or manifest.get('version') != VERSION:
        raise ValueError('Packaged manifest differs')
    binary = files['package/bin/opencrawl']
    if (binary[:6] != b'\x7fELF\x02\x01'
            or int.from_bytes(binary[18:20], 'little') != {'x64': 62, 'arm64': 183}[architecture]):
        raise ValueError('Exact native 64-bit ELF required')
    script = Path(__file__).with_name('inspect.mjs').read_bytes()
    with tempfile.TemporaryDirectory(prefix='opencrawl-cli-native-inspection-') as directory:
        executable = Path(directory) / 'opencrawl'
        executable.write_bytes(binary)
        executable.chmod(0o500)
        result = subprocess.run([str(executable), '-e', script.decode()], cwd='/', timeout=20,
            env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'BUN_BE_BUN': '1',
                 'BUN_RUNTIME_TRANSPILER_CACHE_PATH': '0'}, capture_output=True, text=True)
        if result.returncode or len(result.stdout.encode()) > 16384 or result.stderr:
            raise ValueError('Native inspection failed; no dependency closure inferred')
        observed = json.loads(result.stdout)
    if (observed.get('bun') != '1.3.14' or observed.get('zlib') != ZLIB
            or observed.get('architecture') != architecture or observed.get('platform') != 'linux'
            or observed.get('gzipFileFunctionsInvoked') is not False):
        raise ValueError('Observed runtime differs from reviewed release')
    value = {'package': package, 'version': VERSION, 'metadataUrl': metadata_url,
        'metadataSha256': hashlib.sha256(metadata_bytes).hexdigest(),
        'tarball': expected_url, 'integrity': integrity, 'archiveSha256': hashlib.sha256(archive).hexdigest(),
        'binarySha256': hashlib.sha256(binary).hexdigest(), 'binaryBytes': len(binary),
        'scriptSha256': hashlib.sha256(script).hexdigest(), 'observation': observed,
        'runtimeRemediationProven': False, 'remoteExploitabilityProven': False}
    output.write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps({'package': package, 'version': VERSION, 'architecture': architecture,
        'symbols': observed['symbols'], 'runtimeRemediationProven': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', choices=['x64', 'arm64'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    inspect(args.architecture, args.output)
