import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {archive,crc32,files} from '../scripts/package.mts';
test('reproducible plugin ZIP has exact allowlist, CRCs, Unix modes and fixed timestamps',()=>{
 const entries=files.map(name=>({name,bytes:Buffer.from('fixture '+name)}));const bytes=archive(entries);assert.deepEqual(bytes,archive(entries));assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
 let offset=0;for(const entry of entries){assert.equal(bytes.readUInt32LE(offset),0x04034b50);assert.equal(bytes.readUInt16LE(offset+8),8);assert.equal(bytes.readUInt16LE(offset+10),0);assert.equal(bytes.readUInt16LE(offset+12),0x5c21);const count=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26);assert.equal(bytes.subarray(offset+30,offset+30+length).toString(),entry.name);assert.equal(bytes.readUInt32LE(offset+14),crc32(entry.bytes));assert.deepEqual(inflateRawSync(bytes.subarray(offset+30+length,offset+30+length+count)),entry.bytes);offset+=30+length+count;}
 const directory=offset;for(const entry of entries){assert.equal(bytes.readUInt32LE(offset),0x02014b50);assert.equal(bytes.readUInt16LE(offset+4),(3<<8)|20);assert.equal(bytes.readUInt32LE(offset+38),(0o100644<<16)>>>0);assert.equal(bytes.readUInt16LE(offset+30),0);assert.equal(bytes.readUInt16LE(offset+32),0);offset+=46+Buffer.byteLength(entry.name);}
 assert.equal(bytes.readUInt32LE(offset),0x06054b50);assert.equal(bytes.readUInt16LE(offset+8),files.length);assert.equal(bytes.readUInt32LE(offset+16),directory);assert.equal(bytes.length,offset+22);
});
