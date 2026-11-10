import {request} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
/** One Airbyte protocol command (spec/check/discover/read) in a source image. */
export interface ConnectorRun {
  image: string; command: 'spec' | 'check' | 'discover' | 'read';
  /** JSON documents made available to the command; their paths are passed with --config/--catalog/--state. */
  files?: Partial<Record<'config' | 'catalog' | 'state', unknown>>;
  signal?: AbortSignal; label?: string;
}
/** stdout lines are delivered in order and awaited (backpressure). stderr is never returned: it can echo secrets. */
export interface ConnectorRunner {
  run(input: ConnectorRun, line: (text: string) => unknown | Promise<unknown>): Promise<{exitCode: number; stderrBytes: number}>;
}
export interface DockerRunnerOptions {
  socketPath?: string; network?: string; pull?: 'missing' | 'never';
  memoryBytes?: number; nanoCpus?: number; maxLineBytes?: number; timeoutMs?: number;
}
const LABEL = 'dev.opencrawl.connector-run';
const FLAGS = {config: '--config', catalog: '--catalog', state: '--state'} as const;

/** Minimal ustar writer: regular files under one directory. */
export function tarball(directory: string, files: Record<string, Buffer>) {
  const header = (name: string, size: number, type: '0' | '5', mode: number) => {
    const block = Buffer.alloc(512);
    const field = (value: string, offset: number, length: number) => block.write(value, offset, length, 'utf8');
    const octal = (value: number, offset: number, length: number) => field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    if (Buffer.byteLength(name) > 100) throw new Error('Archive path too long');
    field(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12);
    octal(Math.floor(Date.now() / 1000), 136, 12); block.fill(' ', 148, 156); field(type, 156, 1); field('ustar\0', 257, 6); field('00', 263, 2);
    let sum = 0; for (const byte of block) sum += byte;
    field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return block;
  };
  const parts: Buffer[] = [header(directory + '/', 0, '5', 0o755)];
  for (const [name, body] of Object.entries(files)) {
    parts.push(header(`${directory}/${name}`, body.length, '0', 0o644), body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

/** Splits a stream into newline-delimited lines with a hard per-line bound. */
export function lineSplitter(line: (text: string) => unknown | Promise<unknown>, maxLineBytes = 64 * 1024 * 1024) {
  let parts: Buffer[] = [], size = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const append = (bytes: Buffer) => {
    size += bytes.length;
    if (size > maxLineBytes) throw new Error('Connector output line exceeds supported size');
    if (bytes.length) parts.push(bytes);
  };
  const flush = async () => {const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, size); parts = []; size = 0; const text = decoder.decode(bytes); if (text.trim()) await line(text);};
  return {
    async push(bytes: Buffer) {
      let start = 0, end;
      while ((end = bytes.indexOf(10, start)) >= 0) {append(bytes.subarray(start, end)); await flush(); start = end + 1;}
      append(bytes.subarray(start));
    },
    async end() {if (size) await flush();},
  };
}

/** Docker Engine API over its Unix socket; no docker CLI is required in the runtime image. */
export function dockerRunner({socketPath = '/var/run/docker.sock', network, pull = 'missing', memoryBytes = 2 * 1024 ** 3, nanoCpus = 2e9, maxLineBytes, timeoutMs = 6 * 3600_000}: DockerRunnerOptions = {}): ConnectorRunner & {cleanup(): Promise<number>} {
  function call(method: string, path: string, body?: Buffer | object, contentType = 'application/json'): Promise<IncomingMessage> {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({socketPath, path, method, headers: payload ? {'Content-Type': contentType, 'Content-Length': payload.length} : {}}, resolve);
      req.on('error', reject); req.end(payload);
    });
  }
  async function json<T>(method: string, path: string, body?: Buffer | object, contentType?: string): Promise<T> {
    const res = await call(method, path, body, contentType);
    const chunks: Buffer[] = []; for await (const chunk of res) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    if ((res.statusCode || 500) >= 300) {
      // Docker error bodies name images and containers only; never request bodies.
      let message = ''; try {message = (JSON.parse(text) as {message?: string}).message || '';} catch {}
      throw Object.assign(new Error(`Docker ${method} ${path.split('?')[0]} failed with ${res.statusCode}${message ? `: ${message.slice(0, 200)}` : ''}`), {status: res.statusCode});
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  async function ensureImage(image: string) {
    const inspect = await call('GET', `/images/${encodeURIComponent(image)}/json`); inspect.resume();
    if (inspect.statusCode === 200) return;
    if (pull === 'never') throw new Error(`Connector image ${image} is not available`);
    const at = image.lastIndexOf(':'), slash = image.lastIndexOf('/');
    const [fromImage, tag] = at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest'];
    const res = await call('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`);
    let failure = '';
    // Progress is newline-delimited JSON; a pull error arrives in-band with HTTP 200.
    await new Promise<void>((resolve, reject) => {
      const lines = lineSplitter(text => {try {const event = JSON.parse(text) as {error?: string}; if (event.error) failure = event.error;} catch {}});
      res.on('data', (chunk: Buffer) => {void lines.push(chunk).catch(reject);}); res.on('end', () => {void lines.end().then(resolve, reject);}); res.on('error', reject);
    });
    if ((res.statusCode || 500) >= 300 || failure) throw new Error(`Could not pull connector image ${image}${failure ? `: ${failure.slice(0, 200)}` : ''}`);
  }
  return {
    async run({image, command, files = {}, signal, label = 'connector'}, line) {
      if (!/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(image)) throw new Error('Invalid connector image');
      await ensureImage(image);
      const directory = 'opencrawl-' + randomBytes(8).toString('hex'), args: string[] = [command];
      const contents: Record<string, Buffer> = {};
      for (const [name, value] of Object.entries(files)) {
        if (value === undefined) continue;
        contents[name + '.json'] = Buffer.from(JSON.stringify(value));
        args.push(FLAGS[name as keyof typeof FLAGS], `/tmp/${directory}/${name}.json`);
      }
      const created = await json<{Id: string}>('POST', '/containers/create', {
        Image: image, Cmd: args, Tty: false, AttachStdout: true, AttachStderr: true, Labels: {[LABEL]: label}, Env: [],
        HostConfig: {NetworkMode: network, Memory: memoryBytes, NanoCpus: nanoCpus, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], LogConfig: {Type: 'json-file', Config: {}}},
      });
      const id = created.Id;
      const kill = () => {void call('POST', `/containers/${id}/kill`).then(r => r.resume(), () => {});};
      const timer = setTimeout(kill, timeoutMs);
      signal?.addEventListener('abort', kill, {once: true});
      let stderrBytes = 0;
      try {
        await json('PUT', `/containers/${id}/archive?path=${encodeURIComponent('/tmp')}`, tarball(directory, contents), 'application/x-tar');
        await json('POST', `/containers/${id}/start`);
        // Follow the log stream from the beginning; it ends when the container exits.
        const res = await call('GET', `/containers/${id}/logs?follow=1&stdout=1&stderr=1`);
        if ((res.statusCode || 500) >= 300) throw new Error(`Docker logs failed with ${res.statusCode}`);
        const lines = lineSplitter(line, maxLineBytes);
        let pending = Buffer.alloc(0);
        for await (const chunk of res) {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          // Multiplexed frames: [stream, 0, 0, 0, size(4, big-endian)] then payload.
          while (pending.length >= 8) {
            const size = pending.readUInt32BE(4);
            if (pending.length < 8 + size) break;
            const stream = pending[0], payload = pending.subarray(8, 8 + size);
            pending = pending.subarray(8 + size);
            if (stream === 1) await lines.push(payload); else stderrBytes += payload.length;
          }
        }
        await lines.end();
        const {StatusCode} = await json<{StatusCode: number}>('POST', `/containers/${id}/wait`);
        if (signal?.aborted) throw Object.assign(new Error('Connector run cancelled'), {code: 'ABORT_ERR'});
        return {exitCode: StatusCode, stderrBytes};
      } catch (error) {kill(); throw error;}
      finally {
        clearTimeout(timer); signal?.removeEventListener('abort', kill);
        await call('DELETE', `/containers/${id}?force=1&v=1`).then(r => r.resume(), () => {});
      }
    },
    /** Removes containers left behind by a crashed worker. */
    async cleanup() {
      const containers = await json<Array<{Id: string}>>('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({label: [LABEL]}))}`);
      for (const container of containers) await call('DELETE', `/containers/${container.Id}?force=1&v=1`).then(r => r.resume(), () => {});
      return containers.length;
    },
  };
}
