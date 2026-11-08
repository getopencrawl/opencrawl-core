# Capture privacy and controls

Read this before enabling capture. Capture sends user/agent messages, raw tool
arguments and results, reasoning summaries available in the transcript, and
attachments to the selected deployment. These can contain credentials, private
source code and personal information. There is no automatic secret redaction.
Repeated system/developer prompts are omitted; this is not a secret filter.

Every member of a hosted team can read its captured sessions. In the self-hosted
preview, everyone with the MCP/read token can read the deployment's sessions.
Active conversations are read from their beginning on first encounter, even if
they started before installation. Inactive history requires separate consent.

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

Neither command deletes server data. The self-hosted preview's complete erasure
procedure is in [the self-host guide](self-host.md#delete-a-deployment). Selective
server-side session deletion is not implemented. Hosted deletion requires the
deployment operator to remove raw objects, index records and applicable backups;
do not claim that revoking a token deletes already uploaded content.

No server-side expiry is configured by the preview stack. Backups contain the
same private data and credentials; restrict access and set your own retention.
