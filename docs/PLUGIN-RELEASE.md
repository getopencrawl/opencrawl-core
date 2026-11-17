# Plugin distribution boundary

`plugins/` is MIT licensed and exported to its own public repository; the rest
of core is Apache-2.0. Plugin manifests
and skills are portable client artifacts outside the core runtime package.
They do not import hosted implementation or carry hosted credentials. No runtime
package bump or shell deployment is needed for package-only edits.

Maintain public files in `plugins/`, run its validation and packaging checks,
and core `npm test`. Review every public file before exporting. The public
repository is `getopencrawl/opencrawl-plugins`.

Export only the `plugins/` subtree with `git subtree split --prefix=plugins`,
inspect the resulting Git tree/history, and push that split commit to the public
repository. Never push a core branch or tag to the public repository. Release
ZIPs come from `plugins/scripts/package.mts`; upload only the ZIP and checksum.
Do not include a private repository archive, source history, credentials,
server binaries, or reviewer accounts. Keep public and private Git tags separate.

GitHub publication is not directory publication or proof of hosted service
readiness. See the public directory/authentication documents for the remaining
platform and live verification requirements.

The native Cursor plugin is `plugins/opencrawl-cursor`, selected by the Cursor marketplace manifest. Validate its explicit file allowlist alongside the portable bundle. The Cursor ZIP and checksum are separate artifacts. Cursor capture requires the released CLI and receiver support; publish those before plugin setup acceptance. Public repository export is distinct from Cursor Marketplace review.

`plugins/opencrawl-sessions` holds the Claude Code and Codex plugins that
`opencrawl setup` installs: skill, cloud MCP server and session hooks. It is the
only copy of that content; the CLI embeds its skill and generates nothing for
those clients. The marketplace manifests that select it are at the root of
opencrawl-core (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`),
and setup installs from this repository's default branch with a sparse checkout,
so a merged change reaches new installs without a package release. Installed
copies update only when the plugin `version` changes. Bump it in both plugin
manifests and the Claude marketplace entry together; `plugins/test/sessions.test.mjs`
checks the layout.
