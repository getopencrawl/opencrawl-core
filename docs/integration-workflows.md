# Durable integration lifecycle

Implementation plan for the PostgreSQL application-state migration. This document
records the intended contract; acceptance evidence is required before release.

## Ownership

PostgreSQL owns integration records, desired lifecycle commands, encrypted temporary
API-key handoff, external-create intents, writer admission and measured progress.
Temporal owns durable execution, retries and recovery. Object storage holds raw
connector payloads and immutable attachments. Workflow and activity payloads contain
only scoped command references and bounded nonsensitive results.

## Request and dispatch

A registry transaction accepts a lifecycle command and updates desired integration
state together. It binds environment, tenant, owner and connection incarnation;
sets lifecycleCommandId; and inserts the durable command. Duplicate pending commands
of the same operation reuse their ID. Disconnect supersedes provisioning/sync and
revokes new work before acknowledging the request. No command may reactivate a
connection whose deletion has begun. A reference-only Temporal submission follows
the transaction. A Temporal recovery schedule pages pending PostgreSQL commands,
covering a process death or unavailable Temporal service after the commit.

A temporary API key is encrypted by the SQL adapter before request acceptance. It
is read only inside provisioning activities and deleted after the source ID is
durable, cancellation or command completion. It is never sent in workflow input,
activity results, logs or errors. Existing installations with interrupted key setup
and no retained key remain reconnect-required; migration cannot recreate secrets.

## Provider consent

OAuth sign-in first commits a `consent` command and an integration row in one
PostgreSQL transaction. Temporal prepares the auth configuration and grant; the API
waits briefly for the encrypted result and can return a retryable preparation status.
A retry reuses that command and the same redirect, including after API restart. The
redirect and its one-time state remain in scoped encrypted SQL storage, never in
workflow history, integration JSON, logs or failure details.

Each provider create call first saves a durable intent. A lost response is reconciled
by the persisted exact identity, never by repeating a POST after an empty listing.
Local Slack derives a stable grant ID from the intent and can recover its original
redirect. The broker adapter sends the documented unique account alias and pages
accounts restricted to exact user, auth configuration and alias. If it can recover
the grant but not its original redirect, it queues revocation and requires a fresh
sign-in. See the broker [link API](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink)
and [account list API](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts).

A Temporal timer keeps consent pending until verified callback or expiry, checking
current authorization at least once a minute. Prepared redirects expire at the
provider deadline, capped by a one-hour attempt deadline. Expiry is consent policy;
it never establishes that an uncertain external request did not apply. Declined,
expired and revoked attempts atomically become non-live abandoned records with a
cleanup command. A verified callback supersedes the consent command and erases its
saved redirect before provisioning. Abandoned attempts do not reserve the provider
slot; their accepted cleanup continues after the initiating user loses access.

Cleanup adopts and revokes late-created grants even if abandonment won the race.
An incomplete, empty or ambiguous recovery listing keeps the saved intent and
cleanup command pending for operator investigation. No time-based fallback clears
that uncertainty. Auth configurations are reusable operator configuration; cleanup
revokes the exact connected-account grant, not a shared auth configuration. Legacy
abandoned rows with grants or saved consent intents receive deterministic cleanup
commands in the final migration readiness transaction.

## Provisioning

The workflow executes separate activities for preparation, destination creation,
source creation, connection creation and activation. A command ID is the stable
provisionRun, so retries do not take ownership away from an earlier activity.
Every step re-reads the current record and its command authorization. Existing
external-create intents remain mandatory: Airbyte does not document idempotent
create requests. An ambiguous POST is reconciled against exact scoped resources;
an empty listing never authorizes repeating that POST. Late successful creates
are recorded even if disconnect has superseded the command, allowing cleanup.

## Shared provider resources

Declarative Airbyte definitions, active manifest versions and shared OAuth auth
configurations use a PostgreSQL intent keyed to the exact installation, environment,
provider scope and name. Independent integration commands share this claim. A lost
create or manifest-publication response can only be reconciled by an exact identity
and fingerprint; malformed, incomplete or ambiguous listings never authorize another
POST. Definition/configuration identities cannot silently change. Manifest revisions
serialize through their existing definition and retain unresolved prior requests.
Legacy interrupted setup may adopt existing definitions but cannot issue an
untracked create/update; operators must reconcile that prior outcome first.

## Slack token settlement

Direct Slack grants persist a token-exchange intent before sending a one-shot code
or refresh token. Revocation prevents access immediately but preserves that intent.
A late response is saved as encrypted retirement work and never reactivates the
grant. The disconnect workflow retries retirement of every known access and refresh
token. Normal refresh also retires the prior tokens before allowing another refresh;
the bounded retirement queue must settle before a new provider POST is admitted.
Slack [documents single-token revocation](https://docs.slack.dev/authentication/using-token-rotation/),
so revoking only the access token is insufficient.

A lost exchange response remains unresolved; a process restart or token age cannot
establish its outcome. Legacy active/refreshing/exchanging grants can also have older
tokens that the previous implementation discarded. They retain explicit legacy
uncertainty after known tokens are revoked. Operators must independently establish
provider-side revocation; this implementation does not claim those unknown tokens
were revoked or silently clear the marker. The encrypted retirement record stays
bounded, and provider token values never enter Temporal payloads or failures.

## Disconnect

The workflow closes writer admission, stops provider/scheduled writers, reconciles
outstanding creation, waits for positive write settlement, deletes raw/indexed data,
revokes only grants owned by this deployment and then marks deletion complete.
Uncertain writes do not expire because of elapsed time, cancellation or a crashed
worker. Reconnection uses a new integration ID. The old process-local purge map and
11-minute settling assumption are removed from supported execution.

## Compatibility

Existing Temporal workflow names and histories remain registered. New integration
workflows use new versioned types; do not edit old command sequences. The bundled
Temporal 1.29 server cannot run standalone activities; integration lifecycle is a
real multi-step workflow, not a single-activity job wrapper. Short request deadlines,
status caches, activity heartbeat timers and readiness reporting remain local.

## Required acceptance

- Real PostgreSQL atomic command/state creation and independent-writer races.
- Real Temporal restart/replay between each provider side effect and SQL receipt.
- API death after commit but before dispatch; recovery submits the same command.
- Duplicate creates, delayed ambiguous responses, duplicate workflows and stale commands.
- Disconnect racing provisioning, raw writes and search writes; no timed drain shortcut.
- Cross-tenant references, revoked membership, missing/changed owner and fail-closed scope.
- Workflow histories and failures contain no API keys/provider configuration.
- Existing installation migration preserves pending lifecycle and uncertain write intents.
- Matched backup restoration preserves SQL command state, raw data and Temporal history.

## Airbyte writer settlement

The supported self-host runtime closes native SQL admission and removes indexing
schedules immediately. Search denies a disconnected integration as soon as the
request transaction changes its status. The native writer fence persists uncertain
writes across restarts. Schedule creation and explicit Airbyte sync requests also
participate in this fence, so cleanup cannot outrun a request admitted earlier.

Airbyte currently writes raw landing objects directly with operator-owned storage
credentials. Its connection deletion and job cancellation responses do not establish
that an already dispatched storage write has finished. The runtime therefore keeps
physical cleanup pending with `cleanupBlockedReason=external-writer-proof-required`
until the operator verifies terminal external writers and storage-write disposition.
The source card explains this state. There is no environment flag or elapsed-time
bypass. This is an explicit current limitation of direct Airbyte landing, not a
claim that all external writers are already covered by the SQL fence.

`createIntegrationDrainProofs().recordVerifiedProof` is a restricted operator and
migration seam, never a tenant endpoint. A proof records the evidence and operator
identity against the exact resource version, Airbyte IDs, workspace and landing
scope. It is valid only after all outstanding create intents are reconciled. A late
resource invalidates the old proof. Independently verified evidence must establish
both writer termination and completion or definitive nonapplication of outstanding
storage writes; a cancelled job, a quiet bucket or a successful DELETE alone is
insufficient. Without that evidence, logical disconnect succeeds and data remains
inaccessible while irreversible purge waits safely.

## Progress measurement

The API reads measured counts from PostgreSQL and never scans raw files. Successful
connector indexing activities refresh the corresponding object measurement after
revalidating the current binding. Distinct hashes retain their original protocol.
They are stored as normalized rows; bounded staging batches remain invisible until
an atomic object-completion transaction publishes the hashes and processed marker.
A full-refresh measurement switches syncs only after every listed object in that
sync has completed measurement. A persistent SQL tombstone rejects late writes
following disconnect. Legacy count checkpoints import their IDs, object keys and
full-refresh summaries into these tables; they are not retained as JSON state blobs.

Optional provider estimates run during the preparation activity. Brief provider
status caching and readiness timers remain process local because neither owns a
required continuation or authoritative state.

## Operator cleanup evidence

Use the same installation environment as the API, including `OPENCRAWL_DATABASE_URL`,
`OPENCRAWL_LANDING_S3_BUCKET`, `OPENCRAWL_LANDING_S3_PATH`,
`OPENCRAWL_APP_STATE_NAMESPACE` when configured, and `OPENCRAWL_ORGANIZATION_ID`.
The supported local command verifies the ready installation binding and exact owner:

```sh
node dist/src/state/integration-drain-cli.mjs inspect --integration int_REPLACE_WITH_26_HEX_DIGITS --owner user_OWNER
```

Inspection performs SQL reads only and reports the scoped resource IDs, landing
location, fingerprint, native writer status and whether matching evidence exists.
Before recording evidence, independently establish that the exact Airbyte workers
are terminated and every dispatched storage write either completed or definitively
did not apply. Retain the external evidence outside this command. Cancellation
responses and elapsed time do not establish either fact. If native writers remain
unresolved, investigate their receipts; this command never clears them.

Create a private JSON file with this exact shape, using the inspected fingerprint
and concrete references to the verified operational evidence. Do not include tokens,
credentials, provider response bodies or document contents:

```json
{
  "version": 1,
  "fingerprint": "COPY_THE_INSPECTED_64_HEX_DIGIT_FINGERPRINT",
  "verifiedBy": "operator identity",
  "writerTermination": "Reference to evidence covering the exact terminal workers",
  "storageSettlement": "Reference to evidence covering completion or nonapplication of outstanding writes"
}
```

```sh
node dist/src/state/integration-drain-cli.mjs record --integration int_REPLACE_WITH_26_HEX_DIGITS --owner user_OWNER --evidence /private/path/drain-proof.json
```

Recording rechecks the authoritative resources, outstanding create intents and
closed, fully settled native fence inside one transaction. Changed resources require
new evidence. It stores the attestation; it does not validate the external evidence
or delete data itself. The pending Temporal cleanup activity then retries normally.
This command is restricted to operators with direct installation database access and
is not exposed through tenant HTTP. Failures print a code without evidence contents.
`DRAIN_TARGET_CHANGED` requires a new inspection; `EXTERNAL_WRITER_PROOF_REQUIRED`
means status, create-intent or native-fence prerequisites are unresolved.

The upgrade converts legacy provisioning/recovery and disconnected/disconnecting
rows to deterministic lifecycle commands only in the final readiness transaction,
after exact source readback verification. An interrupted transaction rolls back both
commands and record transitions. Consent-pending and explicit reconnect-required
records remain unchanged. Existing resource versions, create intents, raw deletion
receipts and unresolved native writers are preserved.


## Operator Slack grant settlement

For direct Slack OAuth, inspect an unresolved revoked grant using the same ready
installation settings and `OPENCRAWL_CONNECTOR_KEY` as its worker:

```sh
node dist/src/state/slack-grant-settlement-cli.mjs inspect --integration int_REPLACE_WITH_26_HEX_DIGITS --owner user_OWNER
```

This reads the exact encrypted grant revision and prints only scoped IDs,
uncertainty flags and a fingerprint. Before recording proof, independently verify
that no earlier code exchange or refresh request can issue a usable token, and
that the issuer has revoked all tokens for this exact grant, including tokens the
old installation may have discarded. A verified issuer-side app/grant revocation
and positive disposition of every in-flight exchange are examples of the evidence
required. Consider other connections before performing issuer-side administrative
actions; this command does not uninstall a Slack app or contact Slack itself.
A timeout, local process death, expired browser flow or successful revocation of
only the currently known access token is insufficient.

Save a private JSON file containing concrete evidence references, without tokens:

```json
{
  "version": 1,
  "fingerprint": "COPY_THE_CURRENT_INSPECTED_FINGERPRINT",
  "verifiedBy": "operator identity",
  "exchangeDisposition": "Evidence that all earlier code/refresh requests are terminal and cannot produce usable tokens",
  "providerRevocation": "Issuer evidence covering every token of this exact grant, including previously discarded tokens"
}
```

```sh
node dist/src/state/slack-grant-settlement-cli.mjs record --integration int_REPLACE_WITH_26_HEX_DIGITS --owner user_OWNER --evidence /private/path/slack-proof.json
```

Recording locks the integration and grant, rechecks revoked state and the closed,
fully settled native fence, and rejects a changed fingerprint. The encrypted proof
and any needed cleanup outbox command commit together. Known tokens remain queued
for normal revocation; the command never declares those tokens remotely revoked.
Temporal resumes cleanup without asking an operator to edit SQL. This is a restricted
operator attestation of independently established evidence, not automated verification
of Slack's internal token state. `SLACK_SETTLEMENT_TARGET_CHANGED` requires a fresh
inspection and verification; `SLACK_SETTLEMENT_NOT_READY` means admission, active
requests or grant state are not ready for settlement.
