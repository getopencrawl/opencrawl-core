#!/usr/bin/env node
/** Real generated hooks remain direct harness children, including crash recovery.
 * Run through process-ownership-init.c in a fresh Linux PID namespace. The tiny
 * init fixture exposes raw fork/waitpid only; this TypeScript owns every assertion.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
type Event = {
    id: string;
    kind: string;
    nativeId?: string;
};
type Process = {
    state: string;
    parent: number;
};
function processes() { const result = new Map<number, Process>(); for (const name of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
        const raw = readFileSync('/proc/' + name + '/stat', 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
        result.set(Number(name), { state: fields[0]!, parent: Number(fields[1]) });
    }
    catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
    }
} return result; }
async function until(predicate: () => boolean, seconds = 20) { const end = performance.now() + seconds * 1000; while (!predicate()) {
    assert(performance.now() < end, 'Probe condition timed out');
    await sleep(20);
} }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pending = new Map<ChildProcess, Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
}>>();
function track(child: ChildProcess) { const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
}>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); pending.set(child, done); return child; }
async function waited(child: ChildProcess, seconds = 15) { let timer: NodeJS.Timeout | undefined; try {
    return await Promise.race([pending.get(child)!, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Child process timed out')), seconds * 1000); })]);
}
finally {
    clearTimeout(timer);
} }
async function harness(dist: string, root: string) {
    const scope = join(root, 'node_modules/@getopencrawl');
    mkdirSync(scope, { recursive: true });
    symlinkSync(join(dist, 'linux-x64'), join(scope, 'cli-linux-x64'), 'dir');
    cpSync(join(dist, 'cli'), join(scope, 'cli'), { recursive: true });
    const launcher = join(scope, 'cli/bin/opencrawl.cjs');
    const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCRAWL_CONFIG_HOME: join(root, 'config'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), XDG_CACHE_HOME: join(root, 'cache'), OPENCRAWL_NO_UPDATE: '1', OPENCRAWL_SESSIONS_TOKEN: 'synthetic-process-ownership-fixture' };
    const events = new Map<string, Event>(), state = { block: false, maintenance: false, active: 0, peak: 0, blocked: false };
    const server = createServer((request, response) => { void (async () => { const reply = (data: unknown, status = 200) => { response.statusCode = status; if (status === 503)
        response.setHeader('Retry-After', '60'); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data })); }; if (request.method === 'GET') {
        reply({ principal: { tenantId: 'fixture', userId: 'fixture' } });
        return;
    } assert.equal(request.method, 'POST'); const chunks: Buffer[] = []; for await (const chunk of request)
        chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks), batch = JSON.parse(raw.toString()) as {
        events: Event[];
    }; writeFileSync(join(root, 'retained-batch.json'), raw); state.active++; state.peak = Math.max(state.peak, state.active); try {
        if (state.maintenance) {
            state.blocked = true;
            reply({}, 503);
            return;
        }
        while (state.block) {
            state.blocked = true;
            await sleep(20);
        }
        await sleep(5);
        for (const event of batch.events)
            events.set(event.id, event);
        reply({ stored: true, batchId: sha(raw) });
    }
    finally {
        state.active--;
    } })().catch(error => { response.destroy(error as Error); }); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert(address && typeof address !== 'string');
    const api = 'http://127.0.0.1:' + address.port;
    const setup = track(spawn(process.execPath, [launcher, 'collect', 'install', '--yes', '--harness', 'claude-code', '--defer-auth', '--backfill', 'skip', '--api', api, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
    let output = '', errors = '';
    setup.stdout!.setEncoding('utf8').on('data', (s: string) => { output += s; });
    setup.stderr!.setEncoding('utf8').on('data', (s: string) => { errors += s; });
    assert.equal((await waited(setup)).code, 0, errors);
    const installation = JSON.parse(output) as {
        data: {
            skills: {
                results: Array<{
                    directory: string;
                }>;
            };
        };
    };
    assert(installation.data.skills.results.every(result => { const path = relative(root, result.directory); return path !== '..' && !path.startsWith('../') && !isAbsolute(path); }), 'Skill installation escaped fixture HOME');
    const settings = JSON.parse(readFileSync(join(root, 'claude/settings.json'), 'utf8')) as {
        hooks: {
            Stop: Array<{
                hooks: Array<{
                    async: boolean;
                    command: string;
                }>;
            }>;
        };
    };
    const hook = settings.hooks.Stop[0]!.hooks[0]!;
    assert.equal(hook.async, true);
    assert(hook.command.startsWith('exec '));
    const transcript = join(root, 'claude/projects/fixture/session.jsonl');
    mkdirSync(join(root, 'claude/projects/fixture'), { recursive: true });
    const appendRecord = (identity: string) => appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: identity, sessionId: 'session', message: { role: 'user', content: 'intact synthetic ' + identity } }) + '\n');
    appendRecord('first');
    const capture = join(root, 'config/opencrawl/capture'), lock = join(root, 'config/opencrawl', sha('capture:worker') + '.json.lock'), children: ChildProcess[] = [];
    const launch = () => { const child = track(spawn('/bin/sh', ['-c', hook.command], { env, stdio: ['pipe', 'ignore', 'ignore'] })); child.stdin!.end(JSON.stringify({ session_id: 'session', transcript_path: transcript, hook_event_name: 'Stop' })); children.push(child); return child; };
    const jsonFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : [];
    const drained = () => !jsonFiles(join(capture, 'notices')).length && !jsonFiles(join(capture, 'queue')).length;
    const owns = (child: ChildProcess) => existsSync(lock) && readFileSync(lock, 'utf8') === String(child.pid);
    const noZombies = () => assert(![...processes().values()].some(p => p.state === 'Z'));
    const onlyHarness = () => assert.deepEqual([...processes().keys()].sort((a, b) => a - b), [1, process.pid]);
    try {
        const owner = launch();
        await until(() => owns(owner));
        assert.equal(processes().get(owner.pid!)!.parent, process.pid, 'Uploader lost harness ownership');
        await until(() => events.size >= 2);
        let peak = 0;
        const unexpected = new Set<number>();
        const monitor = setInterval(() => { const hooks = [...processes()].filter(([pid]) => pid !== 1 && pid !== process.pid); peak = Math.max(peak, hooks.length); for (const [pid, p] of hooks)
            if (p.parent !== process.pid)
                unexpected.add(pid); }, 5);
        try {
            let next = 0;
            await Promise.all(Array.from({ length: 8 }, async () => { while (next++ < 200)
                assert.equal((await waited(launch())).code, 0); }));
        }
        finally {
            clearInterval(monitor);
        }
        assert(peak <= 9, 'Capture multiplied the harness hook process count');
        assert.equal(unexpected.size, 0, 'Capture spawned children outside harness ownership');
        await until(drained);
        assert.equal([...events.values()].filter(e => e.kind === 'hook').length, 201);
        assert(state.peak >= 1 && state.peak <= 4, 'Upload request concurrency exceeded its bound');
        assert.deepEqual([...processes().keys()].filter(p => p !== 1 && p !== process.pid), [owner.pid]);
        noZombies();
        appendRecord('late-tail');
        await until(() => [...events.values()].some(e => e.nativeId === 'late-tail'));
        state.block = true;
        appendRecord('after-crash');
        await until(() => state.blocked);
        assert(jsonFiles(join(capture, 'queue')).length);
        owner.kill('SIGKILL');
        assert.equal((await waited(owner, 5)).signal, 'SIGKILL');
        noZombies();
        state.block = false;
        await until(() => state.active === 0);
        const recovered = launch();
        await until(() => owns(recovered));
        await until(drained);
        await until(() => [...events.values()].some(e => e.nativeId === 'after-crash'));
        assert.equal((await waited(recovered, 40)).code, 0);
        onlyHarness();
        assert.equal([...events.values()].filter(e => e.kind === 'hook').length, 202);
        assert.deepEqual(new Set([...events.values()].flatMap(e => e.nativeId ? [e.nativeId] : [])), new Set(['first', 'late-tail', 'after-crash']));
        state.maintenance = true;
        state.blocked = false;
        appendRecord('deadline-retry');
        const bounded = launch();
        await until(() => state.blocked);
        const retained = new Map(jsonFiles(join(capture, 'queue')).map(name => [name, readFileSync(join(capture, 'queue', name))]));
        const started = performance.now();
        assert.equal((await waited(bounded, 100)).code, 0, 'Uploader missed its deadline');
        assert(performance.now() - started < 95000);
        assert(retained.size);
        for (const [name, raw] of retained)
            assert.deepEqual(readFileSync(join(capture, 'queue', name)), raw);
        state.maintenance = false;
        await until(() => state.active === 0);
        const afterDeadline = launch();
        await until(drained);
        assert.equal((await waited(afterDeadline, 40)).code, 0);
        assert([...events.values()].some(e => e.nativeId === 'deadline-retry'));
        onlyHarness();
        return { hooks: 204, deadlineExit: true, deadlineQueueRecovery: true, peakHookProcesses: peak, peakConcurrentRequests: state.peak, zombies: 0, orphanedChildren: 0, killRecovery: true, lateTail: true, idleExit: true, sameHarnessOwnedPid: true };
    }
    finally {
        state.block = false;
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL');
            await waited(child, 5);
        }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
async function main() {
    assert.equal(process.platform, 'linux');
    assert.equal(process.ppid, 1, 'Run through the non-reaping init fixture');
    assert(process.argv[2], 'Built CLI distribution required');
    const channel = new Socket({ fd: 3, readable: true, writable: true }), lines = createInterface({ input: channel })[Symbol.asyncIterator]();
    const rpc = async (command: string) => { channel.write(command + '\n'); const line = await lines.next(); assert(!line.done, 'Test init exited'); return line.value; };
    const root = mkdtempSync(join(tmpdir(), 'opencrawl-ownership-'));
    try {
        const orphan = Number(await rpc('control'));
        await until(() => { const p = processes().get(orphan); return p?.state === 'Z' && p.parent === 1; });
        assert.equal(await rpc('reap ' + orphan), '0');
        const result = await harness(resolve(process.argv[2]), root);
        assert.equal(await rpc('audit'), '1', 'PID 1 adopted a capture process');
        const capture = join(root, 'config/opencrawl/capture'), raw = readFileSync(join(root, 'retained-batch.json')), queue = join(capture, 'queue', sha(raw) + '.json');
        writeFileSync(queue, raw);
        const lock = join(root, 'config/opencrawl', sha('capture:worker') + '.json.lock');
        const [owner, worker] = (await rpc('parent-loss\n' + join(root, 'config'))).split(' ').map(Number);
        assert(owner && worker);
        let ownerReaped = false, workerReaped = false;
        let elapsed = 0;
        try {
            await until(() => existsSync(lock) && readFileSync(lock, 'utf8') === String(worker));
            assert.equal(processes().get(worker)!.parent, owner);
            process.kill(owner, 'SIGKILL');
            assert.equal(await rpc('reap ' + owner), '-9');
            ownerReaped = true;
            const started = performance.now();
            await until(() => { const p = processes().get(worker); return p?.state === 'Z' && p.parent === 1; }, 5);
            assert.equal(await rpc('reap ' + worker), '0');
            workerReaped = true;
            assert.deepEqual(readFileSync(queue), raw);
            assert.equal(await rpc('audit'), '1');
            elapsed = Math.round((performance.now() - started) / 10) / 100;
            const pid1Child = Number(await rpc('pid1-worker\n' + join(root, 'config')));
            try {
                await until(() => existsSync(lock) && readFileSync(lock, 'utf8') === String(pid1Child), 5);
                assert.equal(processes().get(pid1Child)!.parent, 1);
            }
            finally {
                process.kill(pid1Child, 'SIGTERM');
                await rpc('reap ' + pid1Child);
            }
            assert.equal(await rpc('audit'), '1');
        }
        finally {
            for (const [pid, reaped] of [[owner, ownerReaped], [worker, workerReaped]] as const)
                if (!reaped) {
                    try {
                        process.kill(pid, 'SIGKILL');
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                            throw error;
                    }
                    await rpc('reap ' + pid);
                }
        }
        console.log(JSON.stringify({ nonReapingPid1Control: true, ...result, pid1HarnessAccepted: true, parentLossExit: true, parentLossExitSeconds: elapsed, parentLossQueueRetained: true, adoptedChildReapedByTestInit: true }));
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        channel.end();
    }
}
await main();
