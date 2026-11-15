---
name: setup
description: Set up OpenCrawl search and optional Cursor capture.
---

Use the opencrawl skill to connect the plugin MCP with Cursor's native OAuth flow.
If the user wants capture, explain that new Cursor prompts, replies, reasoning,
tool inputs/results and compaction metadata go to their selected OpenCrawl team;
referenced file paths are recorded, and inline images use attachment storage.
Honor an existing setup/capture authorization. Install the native CLI following
https://github.com/getopencrawl/opencrawl-core/tree/main/cli and sign in with
`opencrawl login`. Then run `opencrawl collect install --yes --harness cursor
--backfill skip --json` and `opencrawl skills install --client cursor --json`.
Preserve all other clients, hooks, ownership, exclusions, and pending data.
Reload Cursor after setup and start a new conversation. Use the startup/first-tool
identity receipt and attach one native Shell board listener as described in the
skill, then continue the user's task. Run board diagnostics only when requested.
Verify a stored capture receipt and search/fetch a new
unique message with harness=cursor. Installation and test_connection alone do not
prove capture. Existing history is not imported. If CLI or account access is
missing, state the specific next action. Never request credentials in chat.
