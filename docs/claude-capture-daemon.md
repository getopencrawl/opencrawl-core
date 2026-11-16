# Claude capture daemon proof

This is an opt-in Claude Code proof. The CLI installs the worker together with
capture configuration:

```sh
opencrawl collect install --harness claude-code --daemon --yes --backfill skip
```

The worker is part of the existing native CLI executable. Users do not need
Node, Bun, Rust, a second binary, or another download. Its TypeScript runtime
reuses the existing transcript parser, local secret masking, byte cursors,
immutable queue, authentication, and upload-receipt verification.

Two asynchronous capture hooks replace the eight existing Claude capture hooks.
`SessionStart` writes a small durable registration containing the exact session
and transcript path. `SessionEnd` requests a final drain. Neither parses a
transcript, refreshes credentials, uploads, nor waits for worker startup.
Other integrations' hooks are preserved.

One worker watches the registered transcript and that session's subagent
directory. Filesystem changes trigger incremental reads. A 30-second recovery
check visits only enrolled sessions to recover missed notifications and detect
parent process exit when Claude cancels an asynchronous end hook. Finished
sessions leave the active registry after their final complete records are
spooled. An incomplete final record remains recoverable. The historical
`capture/sources` catalogue is never read by this worker.

Recording and uploading run independently. A blocked network request cannot
hold the local recording loop. Live records share the existing ten-second
batching window. Failed requests retain their exact queued payloads and persist
a capped retry deadline across restarts. Only a matching durable server receipt
permits removing an uploaded batch. Existing destination, author, exclusion,
redaction, attachment, and HTTP 413 behavior remains in the shared uploader.

On macOS, installation creates a user LaunchAgent with crash restart and no
administrator privileges. `opencrawl collect daemon` is the same foreground
worker for environments with their own supervisor. Other environments currently
use a detached process started by installation or a session hook; that fallback
does not promise restart after a crash without another invocation. Linux/VM
supervision and other harness migrations require their own acceptance runs.

`opencrawl collect uninstall` stops the service and removes owned hooks while
retaining queued data. Service restarts preserve the active registrations,
source cursors, retry deadline, and queue. The existing CLI update mechanism
remains responsible for downloading versions; the daemon performs no update
checks of its own.

The staged CLI-first installer uses a separate plugin-owned-hook installation
path. Its integration must preserve explicit forward/history selections and
run the affected onboarding journeys before making this proof the default.

## Verification

Run `bun test cli/test/capture-daemon.test.ts` for isolated-process tests of hook
installation, blocked uploads, final partial records, destination changes,
subagents, unrelated historical sources, lost acknowledgements, idle behavior,
and SIGKILL recovery. The tests use disposable profiles and synthetic receivers.

On macOS with Claude already signed in, an opt-in live harness proof is available:

```sh
bun cli/scripts/claude-daemon-smoke.ts /absolute/evidence/directory [/path/to/native/opencrawl]
```

It runs a synthetic Claude conversation with per-invocation hooks, uses an
isolated receiver, checks durable upload after Claude exits, kills the worker
to verify LaunchAgent restart, checks byte-identical retries, and samples idle
RSS/CPU/network activity. It verifies that shared Claude settings remain
unchanged and removes its temporary service and capture profile afterward.
The generated receipt distinguishes source execution from a compiled native
CLI. This proof does not establish production search visibility or VM survival.
