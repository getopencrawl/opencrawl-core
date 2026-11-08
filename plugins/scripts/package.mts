#!/usr/bin/env node
/** Package the reviewed plugin allowlist with deterministic ZIP metadata. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const files = ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md', 'assets/icon.png', 'mcp.json', 'plugin.json', 'skills/opencrawl/SKILL.md'].sort();
export function crc32(bytes: Buffer) { let crc = 0xffffffff; for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
} return (crc ^ 0xffffffff) >>> 0; }
// The original ZipInfo entries used zlib’s default level 6 despite the outer ZIP level 9.
/** ZIP32 is sufficient for this fixed eight-file plugin; no platform ZIP command or dependency. */
export function archive(entries: ReadonlyArray<{
    name: string;
    bytes: Buffer;
}>): Buffer {
    const local: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const { name, bytes } of entries) {
        const nameBytes = Buffer.from(name, 'utf8'), compressed = deflateRawSync(bytes, { level: 6 }), crc = crc32(bytes);
        assert(nameBytes.length < 65536 && bytes.length <= 0xffffffff && compressed.length <= 0xffffffff);
        assert.deepEqual(inflateRawSync(compressed), bytes);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(8, 8);
        h.writeUInt16LE(0x5c21, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(compressed.length, 18);
        h.writeUInt32LE(bytes.length, 22);
        h.writeUInt16LE(nameBytes.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE((3 << 8) | 20, 4);
        h.copy(c, 6, 4, 30);
        c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        c.writeUInt32LE(offset, 42);
        central.push(c, nameBytes);
        local.push(h, nameBytes, compressed);
        offset += h.length + nameBytes.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    assert(entries.length < 65536 && offset <= 0xffffffff && directory.length <= 0xffffffff);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}
export function packagePlugin() { execFileSync(process.execPath, [join(root, 'scripts/validate.mjs')], { stdio: 'inherit' }); const version: unknown = JSON.parse(readFileSync(join(root, 'opencrawl/plugin.json'), 'utf8')).version; assert(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)); const out = join(root, 'dist'); mkdirSync(out, { recursive: true }); const name = 'opencrawl-' + version + '.zip', bytes = archive(files.map(name => ({ name, bytes: readFileSync(join(root, 'opencrawl', name)) }))); writeFileSync(join(out, name), bytes); const hash = createHash('sha256').update(bytes).digest('hex'); writeFileSync(join(out, 'SHA256SUMS'), hash + '  ' + name + '\n'); console.log(name + ': ' + hash); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    packagePlugin();
