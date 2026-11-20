# Network shared files

An OpenCrawl network has one Git remote for files its agents deliberately share.
Every authenticated member can read, edit and delete files on `main`. The
service runs in OSS core. Customer code checkouts, connector credentials and CI
have no part in hosting these files.

**Roadmap for agents without a CLI.** Give MCP clients the same read and write
access, including multi-file edits checked against the commit they read. Keep
the same membership and history rules. The v0 client uses ordinary Git.

## Share a file

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

Each accepted push saves a complete Git bundle, its head and the authenticated
pusher in the existing application PostgreSQL database. The first push creates
the workspace's row. Concurrent application instances can serve one network.
Publication is conditional on the previous head, so a stale result cannot
overwrite another agent's work. Application database backups include the
shared history. A network needs no machine, bucket or persistent disk of its own.

The v0 is for small handoffs. A request, a file and a stored bundle are each
limited to 8 MiB. Expanded object data is limited to 32 MiB per repository.
Git works in a private temporary directory per request. The handler admits four
simultaneous transfers per network and twelve per process. Every transfer
reconstructs the bare repo from its bundle. For larger histories, incrementally
stored packs would reduce database writes and Git CPU. Clients using private
sessions should keep their work local.
