# Online application-state migration components

The online migration tools support an explicit compatibility release that keeps
the old application serving while PostgreSQL catches up. They are not yet a
complete operator upgrade command. The supported self-host upgrade remains the
[offline migration](app-state-migration.md); the new runtime still requires its
verified application-state admission record.

The `state/online-migration` export provides a durable PostgreSQL write journal,
an S3 adapter, a legacy ObjectStore wrapper, shared source classification, a
legacy-to-journal write authority, a migration-only PostgreSQL shadow mirror,
and a background controller. Separate
`state/online-migration-worker` and `state/online-migration-client` exports use
operator-owned Temporal infrastructure. None selects a hosted account or changes
the application's storage authority automatically.

## Write and replay protocol

Each mutation receives a unique operation ID and increasing per-key revision.
The journal commits its intent before external I/O. Session advisory locks span
the intent commit, conditional external write and reconciliation. A lost response
leaves a pending intent that blocks a newer operation on that key. Retrying the
same operation can recover exact applied evidence. A timeout, elapsed lease or
old source read does not prove that the operation failed.

S3 values carry a source-bound envelope with the operation ID in the body, so
writing equal logical bytes still changes the physical version. Deletion writes
a retained tombstone. Together these prevent a delayed conditional request from
replacing a newer value or recreating deleted state. Raw captures, attachments
and immutable connector pages retain their existing bytes and paths.

Backfill reads and applies an unchanged key under the writer's key gate. Keys
with accepted mutation history belong to journal replay. Replay advances a
contiguous closed frontier and commits its projection and checkpoint together;
it cannot skip a pending intent. The worker reconciles quiet pending keys in
bounded passes and continues replaying after observing parity. Worker restart
and continue-as-new retain progress in PostgreSQL; source payloads and credentials
do not enter Temporal history.

The byte mirror is temporary migration evidence, not an implementation of
`ApplicationState`. The typed projector currently covers account credentials and
revocations, onboarding, role operations, privacy controls, connector secrets,
Replicas records and alias references, Setup status, Slack capture state and pacing, bounded
value reports, board state, write fences and deletion requests. It binds one
epoch to a target namespace and checks source ownership, revisions and independent
typed readback in the replay transaction. New tenant enrollment requires an
explicit trusted verifier and append-only receipt; offline owner bounds remain
unchanged. Unsupported domains fail closed.

Online connector routing can use a verified PostgreSQL registry reader on the
same transaction client. Its binding stays stable while new connections arrive.
Slack capture pins the exact historical prefix and owner; count retirement pins
the logical connection owner, allowing a legitimate reconnect to change its
prefix. The pins survive deletion. Missing, ambiguous or reassigned ownership
fails verification. These migration facts grant no current connector access.

`createOnlineTypedShadow` connects the typed projector to background backfill
and replay. The byte mirror, typed readback and replay checkpoint share one
PostgreSQL transaction. Background parity inspects typed state independently
and detects projection heads missing from the byte mirror. Its physical source
listing must include retained deletion tombstones. Optional coverage tracking
retains each physical page before applying it and advances its cursor only after
accounting for that page's keys. A retry reuses the recorded page. Verified target
evidence commits with backfill or replay, including journal-only keys that were
created behind the listing cursor. Deferred keys whose write was not applied
must receive a real baseline read. Complete traversal and unresolved work remain
separate from final parity and runtime admission.

`createOnlineObjectParticipant` exposes the same typed operations for composition
with additional source owners under one shadow coordinator. It does not create
another journal, mirror or coverage tracker. The host must retain its native
metadata check at activity boundaries. Physical policy identity binds the
classifier grammar and supported session harnesses as well as source routing.

An explicit derived-state retirement policy records old session scheduling,
indexing, cutover markers, connector indexing and count-cache obligations without
reading their historical bodies. These records require current Temporal catchup
or a rebuild; they never assert that indexing is complete or an unknown count is
zero. The connector catchup operation accepts a trusted final online handoff
separately from offline migration receipts and waits for the actual current
workflow results. Session producers and workers derive a fresh generation from
that same handoff. Historical generations can finish only their own markers.
The hosted handoff provider and runtime admission still require integration.

One physical bucket has one source and journal, including an explicitly routed
nested agent-credential namespace. The source policy hash binds those routes and
any native-state preservation decision. Agent and capture credentials retain
separate target identities. A reviewed native PostgreSQL event-identity binding
can preserve historical ledger markers without fetching their bodies or counting
event rows. Coverage records the native binding separately from copied target
rows and rebuild obligations. Compatibility readers retain those markers in
listings but reject direct body access and mutation. A native preservation
certificate does not grant runtime admission.

When the owning native PostgreSQL repository has permanently deleted a session,
an explicit versioned deletion proof can explain removal of its historical
marker during later parity passes. The proof binds the same database UUID,
namespace and canonical session resource, confirms the permanent tombstone and
absence of session metadata, and reads no historical event rows. Missing markers
without that proof remain mismatches. A compatibility deletion adapter must
commit the native tombstone before erasing the exact historical marker versions.

Replicas aliases never publish or delete canonical connections. Their separate
bounded reference inspection must run during final typed parity after replay
reaches the fixed frontier. A missing, deleted or differently owned canonical
connection remains a mismatch. Slack projection retains unfinished runs and
revocation history; pacing can only advance. These projection methods do not
grant runtime admission or start background jobs.

## Release and switch requirements

A compatibility rollout must deploy readers that understand both formats to
every API and worker before enabling journaled writes. It must inventory and
drain old in-flight writers. Reader compatibility and write activation need
separate rollout control; the low-level adapters do not prove fleet enrollment.
After envelopes exist, application rollback must retain compatible readers and
the journal. The original uninstrumented application image cannot read them.

`createOnlineWriteAuthority` binds one namespace, epoch and compatibility
protocol. Explicit preparation starts in legacy mode. Every compatible mutable
write acquires the authority gate, including legacy writes before activation.
Activation takes the exclusive gate, waits for those calls, verifies the injected
fleet enrollment evidence and commits journal mode. A dedicated authority pool
must be separate from callback pools to avoid nested connection starvation.
New object-store adapters require this authority for mutable writes; compatible
readers work independently, and immutable raw object operations remain unchanged.

Journal schema preparation is an explicit operator step. A runtime source
registers its immutable resource binding and enrollment receipt atomically with
the owning catalog, then attaches through read-only metadata checks after a
restart. Request handlers do not create schemas or adopt an unbound source.
The low-level `ready()` helper remains for explicitly unbound migration tooling.

An adapter may supply a bounded `prepareSource` step to the Temporal controller.
Incomplete physical-list preparation retains the existing backfill or replay
cursor and waits; it cannot masquerade as an empty completed source.

Final admission has a separate installation discriminator. The explicit version
2 schema upgrade preserves genuine offline migration IDs and receipts. An online
installation has no offline migration ID, source manifest or completed offline
inventory. Its startup reader requires an exact target identity and canonical
sealed proof matching both the terminal write authority and fenced journal epoch.
Schema preparation and receipt validation alone create no ready installation.

The authority's explicit finalization preparation adds a terminal `target` mode
without changing the current writer mode. Its finalization gate refuses to queue
behind accepted mutations; callers retry once those calls finish. Terminal mode
refuses both legacy and journal callbacks and cannot be reactivated. The final
sealer that verifies parity and commits the receipt with that transition is
still required.

A legacy operation records its dispatch before external I/O. If its outcome or
gate connection becomes uncertain, that durable record blocks later same-key
writes and activation even after a process restart. Only a definitive adapter
rejection can complete a rejected dispatch. There is no timeout-based clearance
or generic operator override. Resolving an uncertain legacy operation requires
a supported source-specific reconciliation/fencing procedure before activation;
that recovery command is still part of the remaining composition work.

Before switching runtime authority, complete the remaining typed domains and
workflow handoff, finish replay, fence legacy mutation admission, drain accepted
operations, and verify typed parity at the resulting closed frontier. Keep signup
and login serving independently of the stateful request drain. Stateful requests
may need a bounded retry response during the handoff; do not acknowledge capture
before its durable write or claim an unmeasured zero-error switch. A live parity
observation alone is not a cutover receipt. Cancel the
migration worker only after the completed authority switch or an explicit abort.

The current components do not implement fleet enrollment, the final complete
typed parity proof, the final request-routing fence, the complete workflow
handoff, a final readiness receipt producer, or a
one-command online upgrade. Those remain release gates. Existing-installation
traffic, signup, capture, restart, deletion and rollback rehearsals must verify
the composed release before production activation.
