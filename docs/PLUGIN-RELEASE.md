# Plugin distribution

[getopencrawl/opencrawl-plugins](https://github.com/getopencrawl/opencrawl-plugins) owns the Claude Code, Codex, Cursor and Antigravity packages. Edit manifests, skills, lifecycle hooks and archive packaging there. Core's CLI downloads the selected platform ZIP, verifies its receipt and checksum, and binds it to the user's profile. The Devin Cloud export and standalone CLI-managed skills remain in `plugins/opencrawl-sessions/`.

For a release, build all twenty archives on a candidate branch and verify installations in isolated harness profiles. Stage a single release containing those archives, their receipts and the managed Codex policy renderer. Update the shared source revision, archive digests and policy digest in `src/sessions/plugin-release.mts`. Run core and CLI checks. Publish the verified release before promoting its consumers. Older CLI versions continue to resolve their immutable assets.

The HTTP MCP registry record is independent of plugin packages. Its manual publishing workflow reads `plugins/registry/server.json`.
