# OpenCrawl Sessions

The harness plugins that OpenCrawl CLI setup installs. Each harness has one
directory, and that directory is the only copy of its content:

| Harness | Directory | Manifest |
| --- | --- | --- |
| Claude Code | `claude-code/` | `.claude-plugin/plugin.json` |
| Codex | `codex/` | `.codex-plugin/plugin.json` |

Each plugin contains:

- `skills/opencrawl/SKILL.md`: retrieval and board coordination guidance. The
  CLI embeds the Claude Code copy as its managed skill for clients without a
  plugin; `../test/sessions.test.mjs` keeps the Codex copy identical.
- `.mcp.json`: the OpenCrawl cloud MCP server, `https://app.getopencrawl.com/mcp`.
- `hooks/hooks.json` and `scripts/opencrawl-hook.sh`: session startup, session
  capture and search context. The hooks only hand the native event to the
  `opencrawl` CLI found on `PATH` (or a common install location). They carry no
  server address, credentials or recording choice. Without the CLI they do
  nothing, and the skill and MCP server still work.

The CLI decides what a hook does: it registers the session, and it records only
when setup saved a recording choice for that harness. Capture is still the
CLI's one engine (the background daemon on a laptop, the one-shot hook upload
elsewhere).

## Install

The marketplace manifests at the repository root list these directories, so
both harnesses install them natively from a sparse checkout:

```sh
claude plugin marketplace add getopencrawl/opencrawl-core --sparse .claude-plugin plugins/opencrawl-sessions
claude plugin install opencrawl-sessions@opencrawl-core --scope user

codex plugin marketplace add getopencrawl/opencrawl-core --sparse .agents/plugins --sparse plugins/opencrawl-sessions
codex plugin add opencrawl-sessions@opencrawl-core
```

`opencrawl setup` runs the same commands. Codex leaves new plugin hooks
untrusted until you review them once in `/hooks`; installing does not grant
trust. Claude Code has no separate hook review.

## Self-hosted servers

The plugin always names the cloud address. For another server the CLI adds a
user-level MCP entry named `opencrawl` for that address:

- Codex: `[mcp_servers.opencrawl]` replaces the plugin's server of the same
  name, and the CLI also sets
  `[plugins."opencrawl-sessions@opencrawl-core".mcp_servers.opencrawl] enabled = false`.
- Claude Code: the user-level entry is added next to the plugin's. Claude Code
  can turn off a single plugin MCP server only per project in `/mcp`, so the
  cloud entry stays listed (signed out) until you disable it there.

## Limits

- Installs follow the default branch of opencrawl-core. An installed copy
  updates only when the plugin `version` changes.

- Hooks need a POSIX shell. They are not Windows-ready.
- Codex loads hooks and MCP only from `.codex-plugin/plugin.json`; the portable
  root `plugin.json` layout drops both in Codex 0.166.
- The hooks use the CLI's default profile. A second `OPENCRAWL_CONFIG_HOME`
  profile is not bound to its own plugin copy.
