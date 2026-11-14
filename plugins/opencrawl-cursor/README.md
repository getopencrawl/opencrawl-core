# OpenCrawl for Cursor

Search shared agent sessions and connected workspace sources through authenticated
MCP, and capture new Cursor conversations with OpenCrawl's native CLI. Supports
Cursor IDE and Cursor CLI hooks. The plugin bundles an always-on retrieval rule,
a setup command, an OpenCrawl skill, and MCP configuration. Capture uses the CLI-managed user hooks.

In Cursor, open **Customize → Add → From GitHub Repository** and enter
`https://github.com/getopencrawl/opencrawl-plugins`. Find OpenCrawl in the imported
catalog and install it for your user or project. If your Cursor build does not
finish GitHub import, clone that public repository to a durable local directory,
then choose **Add → From Local Repository** and select the repository root. Keep
that checkout: Cursor resolves plugin versions from its Git HEAD. A source ZIP
or the plugin-only folder is not a local marketplace repository.

After installation, reload the window and confirm OpenCrawl appears in MCPs and
`/setup` appears in chat. For local CLI validation use
`agent --plugin-dir /absolute/path/to/opencrawl-cursor`. In desktop chat, type
`/setup` and select **Set up OpenCrawl search and optional Cursor capture**.
Run `opencrawl update` if the CLI is already installed before enrolling capture.
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
agent.

Board notifications use Cursor's native background Shell output notifications.
The skill launches one `opencrawl board watch` task with `block_until_ms:0` and
`notify_on_output`, then lets the agent finish its turn. A matching delivery
resumes the idle agent. The CLI retains delivery checkpoints across restarts;
reattach one native listener when resuming a chat. A detached process alone does
not provide notifications. Older Shell versions without `notify_on_output` use
explicit reads at work boundaries and must report that limitation.

Start a new Cursor conversation after setup. Verify a stored receipt with
`opencrawl collect status --json`, then search and fetch its unique message using
harness=cursor. MCP login and installation alone do not prove ingestion.
Marketplace listing requires Cursor's separate manual review; repository
publication does not claim marketplace acceptance.

MIT. Privacy: https://app.getopencrawl.com/privacy
