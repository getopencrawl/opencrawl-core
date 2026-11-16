# Identity boundary

OSS uses Better Auth. The hosted shell continues to use WorkOS. A deployment has
one active provider; there is no token exchange, account synchronization or
fallback from one provider to the other.

`src/identity/types.mts` defines plain account, membership, session and directory
contracts. `workosDirectory` explicitly copies only those fields from the WorkOS
SDK, retaining provider pagination and current session state. The Better Auth
adapter implements the same operations for its fixed organization. Neither
provider’s secrets, SDK models nor browser credentials reach domain operations.

The cloud runtime retains its WorkOS sealed-cookie/PKCE flow, WorkOS CLI device
flow and Connect MCP issuer. Its organization selection and provisioning remain
in shell. The standalone runtime owns Better Auth cookies, password login,
operator bootstrap, invitations, device approval and MCP OAuth consent. Only the
necessary OAuth protocol endpoints are exposed; generic account/admin/plugin
endpoints are unavailable. Custom login uses the Better Auth HTTP pipeline,
including persistent rate limiting. Form writes require the exact public origin.
The server sets the rate-limit IP from the socket and ignores supplied proxy IP
headers. Reverse proxies therefore share their connection IP’s rate limit.

Local invitation possession authorizes a local account. It does not verify its
email address, and account linking is disabled. Bootstrap and invitation
consumption use a PostgreSQL transaction; an initialization marker prevents reopening
bootstrap after account removal. The database refuses a different organization.
Password recovery invalidates sessions and OAuth grants and establishes a token
issuance cutoff. OAuth access tokens require the installation issuer and audience,
`at+jwt` type, a user subject, client ID, expiry and the consented `openid` scope.
An ID token or generic session JWT cannot become a resource credential.

Both compositions turn verified credentials into an explicit principal and apply
the same current membership, role and resource-visibility checks. The five-minute
JWT lifetime bounds ordinary refresh-grant revocation; membership removal and
operator password recovery also deny existing access tokens. Capture credentials
remain separately revocable and write-only. Hosted tenant routing never enters
the standalone adapter.

All browser pages use the shared React document/application entrypoint and design
system. Server responses contain inert typed data, including auth challenges;
they contain no server-rendered feature markup. Cloud extensions use the same
route registry and component tree. Provider-specific auth pages are selected by
the runtime composition, not by cloud conditionals throughout the UI.

The supported standalone stack persists identity and integration state in the
application PostgreSQL database. Better Auth uses its native PostgreSQL adapter
inside an installation-bound schema; it never opens SQLite at runtime. The
application owns shared pool lifetime. Account admission, invitation consumption,
password recovery and local credential invalidation use database transactions.

The offline application-state migration imports the existing Better Auth SQLite
database without recreating accounts, sessions, signing keys, client secrets,
grants or revocation epochs. It validates the original organization binding and
compares canonical per-table counts and hashes before admitting the new runtime.
The migration refuses unknown legacy tables, conflicting target rows and foreign
organizations. Retain the stopped-installation backup, unchanged identity secret
and public issuer URL; changing either invalidates existing authentication even
when stored rows are preserved. PostgreSQL backup/restore replaces the separate
runtime SQLite backups. See `docs/app-state-migration.md` for the required upgrade
and rollback procedure. WorkOS-to-Better-Auth account conversion is not part of
this SQLite-to-PostgreSQL migration.
