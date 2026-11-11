# Capture privacy and controls

Read this before enabling capture. Capture sends user/agent messages, raw tool
arguments and results, reasoning summaries available in the transcript, and
attachments to the selected deployment. These can contain credentials, private
source code and personal information. There is no automatic secret redaction.
Repeated system/developer prompts are omitted; this is not a secret filter.

Every member of a hosted or self-hosted workspace can read its shared captured
sessions and memories. The owner can mark a session or memory private in the
Sessions or Memories page; it is then hidden from teammates, their agents and
search. Owners can also delete individual items, subject to the retained-data
limits described below. See [Sessions and Memories](sessions-and-memories.md).
The separate capture-only Compose stack uses one operator-configured identity;
anyone holding its read token has that identity's access.
Active conversations are read from their beginning on first encounter, even if
they started before installation. Inactive history requires separate consent.

Grok Bot capture has a wider scope than one conversation: its hooks file serves
the whole cloud computer, so every Bot the person runs there is recorded,
including Bots created later and other people's chats with a Bot hosted on that
computer. All of it is attributed to the person who installed capture. Recording
starts when a Bot loads the hooks; earlier conversations are not read. Install
it only on your own Bot computer. See [Grok Bot capture](session-capture.md#grok-bot).

`opencrawl collect install` asks before enabling capture. Noninteractive installs
return `consent_required` without installing hooks; use `--yes` only after the
person approves the recording scope and destination. `--yes` does not approve
history import. Use `--backfill skip` to skip the separate history question.

## Exclude sensitive work

```sh
opencrawl collect exclude --project /absolute/path/to/private-project
opencrawl collect exclude --session-id SESSION_ID
```

Project exclusions cover subdirectories and resolve existing symlinks. Sessions
with an unknown working directory are blocked when project exclusions exist.
Session exclusions also cover Claude subagents with that parent ID. Exclusions
apply to new capture and queued uploads; existing uploads are unchanged. An
upload already in flight finishes before the exclusion command completes.
Excluded pending batches are retained locally until explicitly purged. Exclusions
survive reinstall and local purge; inspect them with `collect status --json`.

For a new installation, review consent and install with `--backfill skip`, then
set exclusions before starting/resuming agents. To change an existing installation
without recording during configuration, uninstall first, set exclusions, then
reinstall. Native transcript files stay under the harness's control.

## Destination changes

Enrollment and queued data are pinned to their original team and human. Changing
the authenticated team stops uploads before attachment bytes are sent. Sign back
into the original destination to finish pending delivery. To switch destinations,
uninstall, resolve the pending queue or explicitly purge it, then reinstall after
reviewing the new destination. OpenCrawl never silently migrates queued captures.

## Stop and delete

```sh
opencrawl collect uninstall
opencrawl collect purge --yes
```

Uninstall stops new collection and preserves pending data. Purge permanently
deletes local capture queues, attachment copies, hook notices and parsing cursors;
it refuses while capture is enabled or its worker is active. Wait for an active
uploader to exit and retry. It preserves original harness transcripts, login
credentials, hook backups and exclusions. Reinstalling after purge can capture
active conversations again from their beginning.

Neither command deletes server data. Owners can delete individual sessions and
memories in the console. Session deletion immediately hides the session, permanently removes its search
projection and every stored version of its raw capture and attachments, and
blocks later uploads for the same owner, harness and native session identity
across installations. The console reports completion only after writes have
settled and erasure is verified; otherwise it shows a pending deletion with Retry.
Legacy owner-shared attachment copies are erased too. Memory deletion removes it from search and ignores that
version; immutable raw snapshots remain, and a newer file version can be captured
again. See the exact [deletion behavior](sessions-and-memories.md#deletion).

For whole-deployment deletion and backup handling, see the
[self-host guide](self-host.md#persistence-deletion-and-backup). Backup copies and
previously downloaded data are not recalled by console deletion.

## Remove workspace access

An admin can remove another member from Team. Confirmed removal immediately denies
that person's workspace requests using existing browser, CLI, MCP and capture
credentials; it does not wait for access tokens to expire. Upload-only capture
credentials are invalidated permanently, even if the person is later reinvited.
Directory-managed members must be removed through their identity provider.

Removal does not delete the person's account, uploaded sessions or memories,
attachments, exports or backups. Other members retain access to shared content;
private content remains private. Previously delivered responses and downloaded
copies cannot be recalled. Remove sensitive server content separately using the
item deletion controls and the deployment's retention procedures.

No server-side expiry is configured by the preview stack. Backups contain the
same private data and credentials; restrict access and set your own retention.
