# OpenCrawl sessions and context suggestions

This canonical harness plugin supplies startup participation, capture, search
identity, context suggestions, MCP configuration and agent guidance. Hooks and
runners are installed byte-for-byte from this repository. The CLI installs the
appropriate platform assets and writes only nonsecret deployment configuration:
`.opencrawl-binding.json`, `.opencrawl-command`, native manifest identity and MCP
endpoint. Native plugin loading and trust remain authoritative.

Run `opencrawl setup` in your terminal to select the endpoint/profile and harness.
A bundle without an explicit binding stays inactive. No default cloud endpoint
or ambient credential can activate it. Context suggestions remain separately
opt-in with `opencrawl context-suggestions enable --harness NAME --api ORIGIN`.

Existing account, recording and history choices are preserved. The local capture
daemon continues to own capture work; the plugin owns lifecycle hook residency.
Cursor must allow native plugin hooks. The CLI does not enable broad imports or
write a new user-hook fallback. Disabled or modified former owned user hooks stop
migration for native review; only exact unchanged owned entries are retired.

The source assets are MIT licensed. Hosted judgment policy and billing are not
part of this bundle. See the core context-suggestions guide for the self-host
judgment and telemetry extension interfaces.
