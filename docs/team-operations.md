# Team role changes and removals

For hosted team changes, the API authenticates the request, records the specific active directory memberships of the administrator and the teammate, persists one operation in the application database, and starts its Temporal workflow before committing the intake transaction. The first activity takes the same operation lock and reads that admission. If the transaction rolled back, the activity has no authorized command. The HTTP caller receives the verified result or a pending-verification error. The workflow survives an HTTP disconnect.

After activation, the operation row itself guards the organization. A partial unique index allows one operation in `guarded`, `dispatching`, or `applied` per organization and namespace. Each operation resolves the current actor and target while it holds that guard. If either membership was replaced while the command was queued, the operation releases its guard and returns a conflict. It records the provider membership ID, credential generations for a removal, and dispatch intent before sending the mutation. After provider acknowledgement, a removal conditionally rotates those generations even if the user has rejoined. It verifies the workspace roster before releasing the guard. Known-safe storage and verification operations retry across worker replacement.

## Operator review

An ambiguous provider mutation leaves the workflow waiting, with its organization guard held. Inspect `opencrawl_team_operations` in the authorized database namespace for the exact organization and operation ID, and the corresponding `team-member/<organization>/<operation>` workflow. During the legacy compatibility stage, also confirm that the matching object-store guard is held by that operation. A pre-Temporal guard with no operation row requires its original recovery procedure before cutover.

Quiesce team writes and outstanding activity attempts before resolving ambiguity. Establish from the directory provider's operation evidence that the specific membership mutation has finished and whether it applied. A timeout, an absent membership, or the age of the guard is insufficient. Record the evidence with the operator action.

- For a confirmed applied mutation, conditionally change that exact row from `dispatching` to `applied`, matching namespace, organization, operation ID and provider membership ID. The workflow performs credential revocation and fresh readback.
- For a provider-confirmed unapplied mutation with no remaining request that can commit, conditionally change the same row from `dispatching` to `release`, with an `outcome` of `{"ok":false,"status":409,"message":"The provider confirmed the team change did not apply."}`.
- For an already acknowledged mutation awaiting verification, correct the cause and retain its `applied` phase.

For hosted team changes, send the workflow the `recheckTeamChange` signal. It re-reads the authoritative operation and guard. The signal alone cannot authorize a provider mutation, a guard release or a credential change. Keep an unresolved operation held while gathering more evidence.

## Self-hosted accounts

The self-hosted API executes the same operation checkpoints synchronously with its local identity provider. At the first team write it conditionally replaces the configured organization’s idle or absent legacy lock with a permanent cutover marker. This marker prevents a restarted older binary from acquiring the legacy lock. A held or malformed lock requires operator reconciliation. Keep the marker when rolling back. PostgreSQL stores subsequent team guards. The API resumes safe checkpoints on startup or at the next team write. For an ambiguous local mutation, verify the original transaction and reconcile its exact operation as above. Restarting the API then completes its readback and revocation.
