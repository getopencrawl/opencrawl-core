# Credential authority and source-write recovery

The capture and delegated-agent families have separate primary keys, even if two
records use the same digest. Authentication reads one credential and its current
owner generation in PostgreSQL. A historical record without a generation uses
the empty generation. A removed member's old tokens stay revoked after they
rejoin. Pending team operations retain their original opaque S3 comparison
versions across cutover, including an explicit null when the marker was absent.

Plan and activation scan only the two families' credential and generation
directories. Activation waits for already-dispatched writes to settle, briefly
serializes credential mutations, and commits all retained rows and their authority
together after exact readback. Authentication continues throughout. A failed
activation rolls back the target rows. Verify before fencing S3 access. After
activation, recover the application with a release that supports PostgreSQL
credential authority. A pre-bridge release reads frozen revocation state and
must stay stopped.

## Resolve one outstanding S3 write

If activation reports an in-flight or uncertain source write, retry once the
request finishes. A crashed process or ambiguous response leaves a durable
intent. Never discard an intent based on its age. This recovery keeps authority
in object storage throughout and prints only the outcome and count.

1. Stop and drain all credential writers for this installation, including team
   activity workers and operator tools. Hold the deployment lock. Confirm the
   configured database namespace, source bucket and prefix.
2. In that namespace only, inspect the stranded row in
   `opencrawl_credential_source_writes`. Keep its operation UUID, family, kind
   and request time in the incident. Inspect the exact source key and storage
   request/version audit privately. Keep bearer values, digests, owner details,
   paths and object bodies out of logs and tickets.
3. A null `intended_hash` proves the write never reached dispatch. Otherwise,
   establish whether the original provider request applied or definitely failed
   and cannot still complete. A process exit or a matching single object read
   cannot prove a terminal provider outcome. If the result is ambiguous, keep
   the fence and obtain provider evidence.
4. Check the security effect at the exact key. An unacknowledged issuance may
   remain absent. A single revocation must have removed access. An unconditional
   owner rotation must have changed the original generation. A conditional
   rotation may have been superseded by a later generation. If a confirmed
   failed revocation left access live, use the compatible, authorized credential
   service to retry that one revocation, then drain it. For an owner marker use
   `revokeVersion` with the original physical comparison when available,
   preserving any newer rotation and tokens granted after it. Keep sources and
   their version history intact. Do not mint replacement tokens during repair.
5. From the compatible image call
   `state.reconcile(operation, async () => ({writersDrained:true, terminal, reference}))`
   on the same `createCredentialState(database,store,prefix)` used by the receiver.
   Supply the incident's verified provider outcome (`applied`, `not-applied`, or
   `not-dispatched`) and its evidence reference. The callback is the operator's
   attestation. The repository locks the exact intent and reads its source twice
   to verify a stable, safe result. It deletes only that proven intent. A
   replay reports `resolved:false`. Resume the compatible writers, then run
   plan, activation and verification again.

Every bridge dispatch checks that its intent is still admitted. A process that
resumes after its pre-dispatch intent was reconciled cannot send the old PUT.
