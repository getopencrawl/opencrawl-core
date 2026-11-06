# Organization search realms

Every tenant has one search realm per environment. Connectors, sessions and the
agent board write the same physical index and use the same mapping and transport:
`opencrawl-<environment>-realm-<sha256(tenantId)>-v1`. A realm is a data namespace;
indexes in the same OpenSearch cluster still share compute and availability.

Each indexed document has `schema`, `tenantId`, `corpus`, `id`, `source`, `kind`,
common `text`/`title`, an ISO `timestamp` when known, `author` when known, and a
source reference when present. Source-specific fields live under `connector`,
`session`, or `board`. Text is stored once. Native timestamps and identifiers are
preserved in the typed metadata; normalization does not discard source precision.
The stored `_id` is `<corpus>:<source-document-id>`, so equal IDs in different
corpora cannot overwrite each other.

`createRealm` binds trusted tenant identity to an index. Its mapping metadata pins
that tenant and schema. All reads add tenant/corpus constraints and validate returned
identities; writes reject foreign owners. Partial or failed engine responses are
errors. Source adapters retain resource-level checks: a public Slack channel or
current parent revision must still authorize a connector result. Sharing a realm
does not make every source document visible to every member. Hosted membership
resolution stays outside core and must run on every request, including cursors.

The realm is a search projection. Captured source records and board messages remain
authoritative in their durable stores. A source adapter's public response can be
specialized (for example, compact board facets); its index routing, schema,
transport and tenant boundary all come from this shared implementation.

## Self-hosting and upgrade

Use the same `OPENCRAWL_TENANT_ID`, OpenSearch endpoint and realm index for sessions
and the board; connector bindings must use that tenant too. The default tenant for
the two server entry points is `self-hosted`. An existing board that used `local`
must keep `OPENCRAWL_TENANT_ID=local` until an explicit owner migration is performed.
`OPENCRAWL_OPENSEARCH_INDEX` is an optional explicit organization realm, not a
separate per-feature index. Existing flat indexes are not compatible with the new
mapping and must be migrated rather than relabeled in place.

Core 0.2.2 performs one additive realm mapping upgrade: the integer
`connector.normalizerVersion`. It validates the tenant/schema and all previous
field mappings before adding that field, then reads the mapping back. Foreign
owners or incompatible mappings fail without modification. This supports Slack
v5 receipt replay within the same realm; it does not rebuild or reset any corpus.

`legacyRealmSource` and `migrateRealmCorpus` provide the portable migration. Drain
legacy writers and set `index.blocks.write=true` on the source first. Read serving
and durable capture can continue. The migration records the index UUID and primary
shard sequence barriers, validates every source owner, copies bounded pages,
reads each document back, compares its full canonical content, and only then
checkpoints the cursor. A source-version change rejects a resume. Final exact
counts are required before marking the copy complete. Old indexes and durable
source data are retained. Switching live routing and restarting writers belong
to the runtime deployment transaction.

Do not replay historical personal ownership into an organization by guessing a
membership. Preserve that scope until an explicit ownership migration authorizes
broader visibility. Migration receipts are provenance, not authentication.

References: [OpenSearch index write blocks](https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/index-settings/)
and [shard sequence statistics](https://docs.opensearch.org/latest/api-reference/index-apis/stats/).
