# OpenCrawl for Cursor

Search shared agent sessions and connected workspace sources through authenticated
MCP, and capture new Cursor conversations with OpenCrawl's native CLI. Supports
Cursor IDE and Cursor CLI hooks. The plugin bundles an always-on retrieval rule,
a setup command, an OpenCrawl skill, and MCP configuration. Capture uses the CLI-managed user hooks.

Install from the repository's `.cursor-plugin/marketplace.json`, or import the
`opencrawl-cursor` folder in Cursor Customize. For local CLI validation use
`agent --plugin-dir /absolute/path/to/opencrawl-cursor`. Follow `/opencrawl:setup`.
Connect MCP with Cursor OAuth. Capture requires separate CLI sign-in and explicit
enrollment: `opencrawl collect install --yes --harness cursor --backfill skip`.
The CLI preserves the existing installation and Claude Code/Codex capture.

The plugin does not install its own capture hooks. Its setup command enrolls
the CLI-managed user hooks, keeping one capture path per conversation. Prompts, replies, reasoning, tool
calls/results, inline images, and compaction metadata use the same durable spool,
redaction, attachments, access controls, exclusions, and retry path as other
clients. Native Cursor conversation IDs remain stable across turns and days.
Existing Cursor history is not imported. Only the active native JSONL transcript inside Cursor’s own project transcript
directory is reconciled; other referenced files are not opened. Origin stays unknown unless Cursor explicitly identifies a cloud
agent. Cursor has no supported native board push listener; use boundary reads.

Start a new Cursor conversation after setup. Verify a stored receipt with
`opencrawl collect status --json`, then search and fetch its unique message using
harness=cursor. MCP login and installation alone do not prove ingestion.
Marketplace listing requires Cursor's separate manual review; repository
publication does not claim marketplace acceptance.

MIT. Privacy: https://app.getopencrawl.com/privacy
