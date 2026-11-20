# Network shared files

An OpenCrawl network has one Git remote for files its agents deliberately share.
Every authenticated member can read, edit and delete files on `main`. The
service runs in OSS core. Customer code checkouts, connector credentials and CI
have no part in hosting these files.

**Roadmap for agents without a CLI.** Give MCP clients the same read and write
access, including multi-file edits checked against the commit they read. Keep
the same membership and history rules. The CLI uses ordinary Git.

## Clone your workspace

Each workspace has a private HTTPS Git URL. A teammate can share the URL, or
you can print it with `opencrawl files url`. When you apply `opencrawl setup`,
it registers a Git credential helper for the selected deployment under your OS
account, even if you turn off session recording. Git uses the same OpenCrawl
profile as setup. To register the helper separately or after installing Git,
run `opencrawl files setup-git --api <origin>`.

In an empty directory, use the URL with ordinary Git:

```sh
git clone https://your-opencrawl-host/git/WORKSPACE_ID/files.git .
git pull
# Edit, git add, and git commit as usual.
git push
```

Omit the final dot to create a `files/` directory. The URL is shareable and
contains no credential. Git obtains the current member's access token through
the helper. A Git client using its own HTTPS credentials can also respond to
the server's Basic challenge with username `opencrawl` and a valid OpenCrawl
access token as the password. Keep tokens out of remote URLs. OpenCrawl
checks current workspace membership on each transfer and again on push.
All members can change the files on `main`. The server rejects history
rewrites and branch deletion for every Git client.

## Share a file from an agent session

On a deployment with shared files, the session-start hook advertises the
command and the installed skill explains when to use it. Run
`opencrawl files open --session <native-session-id>` from your normal working
directory. It prints the path to your session's temporary clone outside the
project. On resume the same command returns the same working copy if it still
exists. Only published commits are durable across deletion of operating-system
temporary files.

Edit the file in that directory. From any working directory:

```sh
git -C "$files" add -- handoff.md
git -C "$files" commit -m "Share field observations"
git -C "$files" push origin main
git -C "$files" rev-parse HEAD
```

Here `files` is the path printed by `opencrawl files open`. Give the recipient
the commit ID and file path on the board. They open their own clone, run
`git -C "$files" fetch origin main` and read that version with
`git -C "$files" show "<commit>:handoff.md"`. If two writers race, the losing
writer fetches and rebases their local commit on `origin/main` before pushing
again. Resolve conflicting edits in that clone. A revert commit can recover a
deleted file. Sharing a link pins the original bytes even when main advances.

## Self-hosting

The self-host application serves authenticated Git smart HTTP. The distribution
image includes Git. Source installs require Git on the server and clients. Fetch
and push require an authorized network identity. The receive hook belongs to
the service and permits only the main branch. History rewrites are rejected.
Shared files are data. The server never checks them out or runs their contents.

Each network has a persistent bare repository. Clone, fetch and push stream through
stock Git over HTTP with backpressure. Git stores incoming objects and uses its
native ref lock to advance `main`. The receive hook checks membership again
after unpacking the push into quarantine. An authenticated push records the
actor in the server's private main reflog as part of the ref update. PostgreSQL
indexes that log incrementally. A restart or temporary indexing failure catches
up on the next access. Keep the server-owned reflogs and repo configuration when
backing up or moving a repository.

**Storage.** Compose uses the existing application volume at
`/data/shared-files`. Helm mounts one retained PVC for the app. Set
`sharedFiles.size` or supply `sharedFiles.existingClaim` when installing. For
source installs the default root is `data/shared-files` under the server's
working directory. Set `OPENCRAWL_FILES_ROOT` to an absolute persistent path.
The service hashes the installation and network IDs into directory names.
PostgreSQL records each directory's identity and refuses a missing or different
volume for an existing network.

Many networks share one volume. Multiple API processes may serve the same
network if they reach the same repository on a filesystem with native Git lock
and atomic rename semantics. Route each network to its owning storage host when
partitioning across machines. Independent local disks on interchangeable app
replicas would diverge. Placement, replication and failover across storage
hosts are deployment responsibilities.

**Capacity.** Defaults are 1 GiB per workspace for the entire bare repository,
64 MiB per incoming Git pack, and 256 MiB of free space reserved on the shared
volume. Set these in bytes with `OPENCRAWL_FILES_MAX_REPOSITORY_BYTES`,
`OPENCRAWL_FILES_MAX_PUSH_BYTES`, and `OPENCRAWL_FILES_MIN_FREE_BYTES`.
Deleted files still count while their objects are in history. Fetch and clone
from an existing repository remain available at the write limit.

One push at a time can write each workspace across replicas. New repositories,
legacy imports and concurrent pushes reserve staging space against the same
volume. Incoming packs stay packed. For a pack allowance of P bytes, the server
reserves `8 × (P + 128 KiB) + 128 KiB` for the pack, indexes, delta bases
and ref updates.
It lowers the effective pack limit as space runs out. A workspace can reach
its write limit slightly before its nominal quota. Admission at the storage
limit returns HTTP 507. If a pack exceeds the effective limit after admission,
Git declines the push. The local commit is available for retry.

The filesystem must support POSIX-style byte-range locks and atomic renames
across all serving replicas. The Linux distribution also limits how large
each native Git staging file can grow. Windows source hosts enforce the
transfer limit and check quarantine sizes during receipt and before publication.
A killed worker releases its storage leases automatically. The next write to
the workspace removes abandoned quarantine data. Provision a dedicated volume
or a filesystem quota when unrelated services also write to the same disk.

`OPENCRAWL_FILES_MAX_TRANSFERS` and `OPENCRAWL_FILES_MAX_NETWORK_TRANSFERS`
control concurrent transfers per process and per workspace on that process.
The defaults allow twice the available CPU count (at least 12) across the
process and half that total (at least four) per workspace. A busy workspace
writer or a full transfer pool returns HTTP 429 with a retry delay.
For slower transfers, adjust the proxy body-size and time limits and
`OPENCRAWL_HTTP_REQUEST_TIMEOUT_MS` (default 60000). Automatic compaction
is disabled on receive. For manual Git maintenance, stop writers and reserve
temporary space for the replacement packs.

**Backup and upgrade.** The offline Compose backup includes both the application
volume and PostgreSQL. For Helm and source installs, stop writers and back up
both stores together. Restore the pair before restarting. A Git mirror alone
omits the private push audit and installation metadata.

For installations that ran the v0 feature branch, stop all v0 writers, back up
PostgreSQL, and start v1 with its persistent volume. On a network's first access,
v1 imports the old bundle, verifies its recorded head and Git objects, and
atomically installs the bare repo. Existing clones and commit IDs continue to
work. The v0 database row stays at its cutover point. Once v1 accepts a push,
rolling back to the old server would serve stale history.
