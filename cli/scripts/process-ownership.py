#!/usr/bin/env python3
"""Run under unshare --fork --pid --mount-proc. PID 1 deliberately does NOT reap
adopted children during the probe. No Docker, systemd, installed service or secrets.
The real generated async hook must remain a direct child of its simulated harness.
"""
import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time


def processes():
    result = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            result[int(path.parent.name)] = (fields[0], int(fields[1]))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def until(predicate, seconds=20):
    end = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > end:
            raise AssertionError('Probe condition timed out')
        time.sleep(.02)


def harness(dist, node, directory):
    root = Path(directory)
    scope = root / 'node_modules/@getopencrawl'
    scope.mkdir(parents=True)
    # Reuse the actual built platform package, not a second binary copy.
    (scope / 'cli-linux-x64').symlink_to(dist / 'linux-x64', target_is_directory=True)
    shutil.copytree(dist / 'cli', scope / 'cli')
    launcher = scope / 'cli/bin/opencrawl.cjs'
    env = {**os.environ, 'OPENCRAWL_CONFIG_HOME': str(root / 'config'),
           'CLAUDE_CONFIG_DIR': str(root / 'claude'), 'CODEX_HOME': str(root / 'codex'),
           'XDG_CACHE_HOME': str(root / 'cache'), 'OPENCRAWL_NO_UPDATE': '1',
           'OPENCRAWL_SESSIONS_TOKEN': 'synthetic-process-ownership-fixture'}
    events = {}
    state = {'block': False, 'maintenance': False, 'active': 0, 'peak': 0, 'blocked': False}
    mutex = threading.Lock()

    class Receiver(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.reply({'principal': {'tenantId': 'fixture', 'userId': 'fixture'}})

        def do_POST(self):
            raw = self.rfile.read(int(self.headers['Content-Length']))
            batch = json.loads(raw)
            (root / 'retained-batch.json').write_bytes(raw)
            with mutex:
                state['active'] += 1
                state['peak'] = max(state['peak'], state['active'])
            try:
                if state['maintenance']:
                    state['blocked'] = True
                    self.reply({}, status=503)
                    return
                while state['block']:
                    state['blocked'] = True
                    time.sleep(.02)
                time.sleep(.005)
                for event in batch['events']:
                    events[event['id']] = event
                self.reply({'stored': True, 'batchId': hashlib.sha256(raw).hexdigest()})
            finally:
                with mutex:
                    state['active'] -= 1

        def reply(self, data, status=200):
            try:
                self.send_response(status)
                if status == 503:
                    self.send_header('Retry-After', '60')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'data': data}).encode())
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    api = f'http://127.0.0.1:{server.server_port}'
    subprocess.run([node, str(launcher), 'collect', 'install', '--harness', 'claude-code',
                    '--defer-auth', '--backfill', 'skip', '--api', api],
                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=15)
    settings = json.loads((root / 'claude/settings.json').read_text())
    hook = settings['hooks']['Stop'][0]['hooks'][0]
    assert hook['async'] is True
    assert hook['command'].startswith('exec ')
    transcript = root / 'claude/projects/fixture/session.jsonl'
    transcript.parent.mkdir(parents=True)
    def append_record(identity):
        with transcript.open('a') as output:
            output.write(json.dumps({'type': 'user', 'uuid': identity, 'sessionId': 'session',
                                     'message': {'role': 'user', 'content': 'intact synthetic ' + identity}}) + '\n')
    append_record('first')
    capture = root / 'config/opencrawl/capture'
    lock = capture.parent / (hashlib.sha256(b'capture:worker').hexdigest() + '.json.lock')
    children = []

    def launch():
        process = subprocess.Popen(['/bin/sh', '-c', hook['command']], env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process.stdin.write(json.dumps({'session_id': 'session', 'transcript_path': str(transcript),
                                        'hook_event_name': 'Stop'}).encode())
        process.stdin.close()
        children.append(process)
        return process

    def drained():
        return not list((capture / 'notices').glob('*.json')) and not list((capture / 'queue').glob('*.json'))

    try:
        owner = launch()
        until(lambda: lock.exists() and lock.read_text() == str(owner.pid))
        assert processes()[owner.pid][1] == os.getpid(), 'Uploader lost harness ownership'
        until(lambda: len(events) >= 2)
        process_peak = [0]
        unexpected_parents = set()
        monitoring = threading.Event()
        def monitor():
            while not monitoring.is_set():
                snapshot = processes()
                hooks = {pid: entry for pid, entry in snapshot.items() if pid not in (1, os.getpid())}
                process_peak[0] = max(process_peak[0], len(hooks))
                unexpected_parents.update(pid for pid, (_, parent) in hooks.items() if parent != os.getpid())
                monitoring.wait(.005)
        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        def burst(_):
            child = launch()
            assert child.wait(timeout=15) == 0
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(burst, range(200)))
        finally:
            monitoring.set()
            monitor_thread.join()
        assert process_peak[0] <= 9, 'Capture multiplied the harness hook process count'
        assert not unexpected_parents, 'Capture spawned children outside harness ownership'
        until(drained)
        assert len([event for event in events.values() if event['kind'] == 'hook']) == 201
        assert state['peak'] == 1, 'More than one uploader'
        # Nothing except the directly owned uploader may remain after the burst.
        assert {pid for pid in processes() if pid not in (1, os.getpid())} == {owner.pid}
        assert not any(status == 'Z' for status, _ in processes().values())
        append_record('late-tail')
        until(lambda: any(event.get('nativeId') == 'late-tail' for event in events.values()))
        # Kill during a request. The harness waits/reaps; durable data must survive.
        state['block'] = True
        append_record('after-crash')
        until(lambda: state['blocked'])
        assert list((capture / 'queue').glob('*.json'))
        owner.kill()
        assert owner.wait(timeout=5) == -signal.SIGKILL
        assert not any(status == 'Z' for status, _ in processes().values())
        state['block'] = False
        until(lambda: state['active'] == 0)
        recovered = launch()
        until(lambda: lock.exists() and lock.read_text() == str(recovered.pid))
        until(drained)
        until(lambda: any(event.get('nativeId') == 'after-crash' for event in events.values()))
        # Natural idle shutdown, not only kill-and-wait cleanup.
        assert recovered.wait(timeout=40) == 0
        assert set(processes()) == {1, os.getpid()}, 'Orphan, zombie or live descendant remained'
        assert len([event for event in events.values() if event['kind'] == 'hook']) == 202
        assert {e.get('nativeId') for e in events.values() if e.get('nativeId')} == {'first', 'late-tail', 'after-crash'}
        # A real compiled managed hook must bound prolonged maintenance retries.
        state['maintenance'] = True
        state['blocked'] = False
        append_record('deadline-retry')
        bounded = launch()
        until(lambda: state['blocked'])
        retained = {p.name: p.read_bytes() for p in (capture / 'queue').glob('*.json')}
        started = time.monotonic()
        assert bounded.wait(timeout=100) == 0, 'Owned uploader missed its process deadline'
        assert time.monotonic() - started < 95
        assert retained and all((capture / 'queue' / name).read_bytes() == raw for name, raw in retained.items())
        state['maintenance'] = False
        until(lambda: state['active'] == 0)
        after_deadline = launch()
        until(drained)
        assert after_deadline.wait(timeout=40) == 0
        assert any(e.get('nativeId') == 'deadline-retry' for e in events.values())
        assert set(processes()) == {1, os.getpid()}
        return {'hooks': 204, 'deadlineExit': True, 'deadlineQueueRecovery': True,
                'peakHookProcesses': process_peak[0], 'concurrentUploaders': state['peak'], 'zombies': 0,
                'orphanedChildren': 0, 'killRecovery': True, 'lateTail': True,
                'idleExit': True, 'sameHarnessOwnedPid': True}
    finally:
        state['block'] = False
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait()
        server.shutdown()
        server.server_close()


def parent_loss(dist, directory):
    """An actual dead harness cannot reap. PID 1 reaps this explicit death test;
    the ordinary burst/deadline test above still runs with no adopted-child reaping.
    """
    root = Path(directory)
    capture = root / 'config/opencrawl/capture'
    raw = (root / 'retained-batch.json').read_bytes()
    queued = capture / 'queue' / (hashlib.sha256(raw).hexdigest() + '.json')
    queued.write_bytes(raw)
    read_fd, write_fd = os.pipe()
    owner = os.fork()
    if owner == 0:
        os.close(read_fd)
        env = {**os.environ, 'OPENCRAWL_CONFIG_HOME': str(root / 'config'),
               'OPENCRAWL_NO_UPDATE': '1', 'OPENCRAWL_SESSIONS_TOKEN': 'synthetic-process-ownership-fixture'}
        worker = subprocess.Popen([str(dist / 'linux-x64/bin/opencrawl'), 'collect', 'worker'],
                                  env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.write(write_fd, str(worker.pid).encode())
        os.close(write_fd)
        while True:
            time.sleep(1)
    os.close(write_fd)
    worker = int(os.read(read_fd, 64))
    os.close(read_fd)
    lock = capture.parent / (hashlib.sha256(b'capture:worker').hexdigest() + '.json.lock')
    try:
        until(lambda: lock.exists() and lock.read_text() == str(worker))
        assert processes()[worker][1] == owner
        os.kill(owner, signal.SIGKILL)
        os.waitpid(owner, 0)
        started = time.monotonic()
        until(lambda: processes().get(worker) == ('Z', 1), 5)
        _, status = os.waitpid(worker, 0)
        assert os.waitstatus_to_exitcode(status) == 0
        assert queued.read_bytes() == raw
        assert set(processes()) == {1}
        # PID 1 may itself be the real harness; do not reject that valid owner.
        env = {**os.environ, 'OPENCRAWL_CONFIG_HOME': str(root / 'config'),
               'OPENCRAWL_NO_UPDATE': '1', 'OPENCRAWL_SESSIONS_TOKEN': 'synthetic-process-ownership-fixture'}
        pid1_child = subprocess.Popen([str(dist / 'linux-x64/bin/opencrawl'), 'collect', 'worker'],
                                     env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until(lambda: lock.exists() and lock.read_text() == str(pid1_child.pid), 5)
            assert processes()[pid1_child.pid][1] == 1
        finally:
            pid1_child.terminate()
            pid1_child.wait(timeout=5)
        assert set(processes()) == {1}
        return {'pid1HarnessAccepted': True, 'parentLossExit': True, 'parentLossExitSeconds': round(time.monotonic() - started, 2),
                'parentLossQueueRetained': True, 'adoptedChildReapedByTestInit': True}
    finally:
        for pid in (owner, worker):
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass


def main():
    assert os.getpid() == 1, 'Run in a fresh PID namespace'
    # Positive control: this PID 1 really leaves adopted children as zombies.
    read_fd, write_fd = os.pipe()
    intermediate = os.fork()
    if intermediate == 0:
        os.close(read_fd)
        orphan = os.fork()
        if orphan == 0:
            os.close(write_fd)
            time.sleep(.2)
            os._exit(0)
        os.write(write_fd, str(orphan).encode())
        os._exit(0)
    os.close(write_fd)
    orphan = int(os.read(read_fd, 64))
    os.close(read_fd)
    os.waitpid(intermediate, 0)
    until(lambda: processes().get(orphan) == ('Z', 1))
    os.waitpid(orphan, 0)  # Clean up ONLY the positive control.
    with tempfile.TemporaryDirectory(prefix='opencrawl-ownership-') as directory:
        result_path = Path(directory) / 'result.json'
        harness_pid = os.fork()
        if harness_pid == 0:
            try:
                result = harness(Path(sys.argv[1]).resolve(), sys.argv[2], directory)
                result_path.write_text(json.dumps(result))
                # Stay alive until PID 1 audits; do not become the test's own zombie.
                while True:
                    time.sleep(1)
            except BaseException:
                import traceback
                traceback.print_exc()
                os._exit(1)
        try:
            until(lambda: result_path.exists() or processes().get(harness_pid, ('', 0))[0] == 'Z', 240)
            assert result_path.exists(), 'Harness probe failed'
            assert set(processes()) == {1, harness_pid}, 'PID 1 adopted a capture process'
            result = {'nonReapingPid1Control': True, **json.loads(result_path.read_text())}
        finally:
            os.kill(harness_pid, signal.SIGKILL)
            os.waitpid(harness_pid, 0)
        result.update(parent_loss(Path(sys.argv[1]).resolve(), directory))
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
