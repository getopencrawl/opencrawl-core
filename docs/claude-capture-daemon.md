# Claude capture daemon proof

The initial native acceptance proof targets Claude Code. Shared adapters and
OS supervision are being integrated into the CLI-first installer; their native
acceptance is a separate release gate. The opt-in Claude proof is installed with:

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
check visits only its pending inbox and enrolled sessions to recover missed
notifications and detect parent process exit when Claude cancels an asynchronous
end hook. The inbox check remains scheduled with no active transcript watches,
so event-only sessions cannot strand a durable handoff after a lost notification. Finished
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
administrator privileges. Linux uses a systemd user service when a user manager
is available. Otherwise installation reports that an external supervisor is
required; a detached process is never reported as supervised. Windows uses an
interactive-user scheduled task that starts the native executable directly,
with a one-minute failure restart interval and no running PowerShell wrapper.
Linux and Windows adapters still require their own native acceptance runs.

`opencrawl collect daemon` is the same foreground worker for cloud supervisors.
The provider setup must bind its authenticated installation before native hooks
start, and must verify restart and VM resume. Devin and Replicas keep separate
provider identities. Their behavior is not established by local LaunchAgent tests.

`opencrawl collect uninstall` stops the service and removes owned hooks while
retaining queued data. Service restarts preserve the active registrations,
source cursors, retry deadline, and queue. The existing CLI update mechanism
remains responsible for downloading versions; the daemon performs no update
checks of its own.

The staged CLI-first installer uses a separate plugin-owned-hook installation
path. Its integration must preserve explicit forward/history selections and
run the affected onboarding journeys before making this proof the default.

## Shared native adapters

Capture hooks enqueue bounded records in the same installation-bound inbox.
The worker reads one payload at a time in bounded rounds. A failing session
retains its event order without preventing other sessions from progressing.
Session startup tasks use an independent lane in the same process, so bootstrap
requests cannot hold recording or uploads. Pausing capture preserves its queue;
explicit uninstall stops both capture and background startup.

Cursor and Grok Bot need native content events because their transcripts do not
contain all tool inputs, results, thoughts and compactions. Cursor also tails
only the JSONL path supplied by its hook, using the existing occurrence dedupe.
Antigravity preserves native tool verification evidence and prefers the session's
full transcript, including when that file appears after startup. Codex can
resolve a missing path or child source by the known ID in its native SQLite
primary-key index. It does not scan transcript directories or the global title
catalogue. Unsupported native schemas remain an acceptance concern.

Only Claude's two-hook reduction has native proof. Other hook lists remain
unchanged until client-specific tests demonstrate that fewer hooks retain all
required data. Some native clients synchronously await the small disk handoff;
capture parsing, authentication, upload and startup network work stay background.
Clients without a session-owned process ID retire inactive watches after five
minutes and resume from the same byte cursor on the next native hook.

The combined candidate must also establish pre-consent Cursor byte boundaries
and enforce exact-session canonical paths and transcript header identities.
These integration requirements cannot be inferred from lexical path validation.

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

`bun cli/scripts/daemon-supervisor-smoke.ts /absolute/evidence/directory
[/path/to/native/opencrawl]` tests an isolated OS service, forced termination,
restart and uninstall. It never modifies native client settings. An unavailable
supervisor fails the proof rather than producing a passing detached-process result.
