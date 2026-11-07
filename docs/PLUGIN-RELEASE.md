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
ZIPs come from `plugins/scripts/package.py`; upload only the ZIP and checksum.
Do not include a private repository archive, source history, credentials,
server binaries, or reviewer accounts. Keep public and private Git tags separate.

GitHub publication is not directory publication or proof of hosted service
readiness. See the public directory/authentication documents for the remaining
platform and live verification requirements.
