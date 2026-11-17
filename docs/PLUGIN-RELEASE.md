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

Lifecycle-capable installation uses the canonical `plugins/opencrawl-sessions`
assets: per-harness/platform hook definitions, shared native runners and skills.
The CLI embeds those source bytes in its native executable, installs them through
native plugin discovery, and writes explicit endpoint/profile/command data plus
native manifest/MCP configuration. It does not generate hook scripts or new user
hooks. `assets.ts` is the import inventory, not a second implementation. Update
these files and release the CLI together. The existing public MCP-only bundles
remain separate until their directory release adopts the lifecycle bundle.
