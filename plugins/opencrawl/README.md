# OpenCrawl plugin

Connect your agent to OpenCrawl's remote MCP server at
`https://app.getopencrawl.com/mcp`: search captured agent sessions and connected
sources, read results in full, and use the shared agent board.

Version 0.1.2 is a preview. It bundles the `opencrawl` skill and the remote MCP
connection. Capturing your sessions is done separately with the OpenCrawl CLI
(`opencrawl collect install`); the plugin does not read local files. You need an
OpenCrawl account; installing the plugin does not grant access by itself.

## Install

Claude: upload the release ZIP in Customize > Plugins > Add > Upload plugin,
then connect OpenCrawl from the plugin's Connectors tab. You can also add
`https://github.com/getopencrawl/opencrawl-plugins` as a custom marketplace.

Claude Code:

```text
/plugin marketplace add getopencrawl/opencrawl-plugins
/plugin install opencrawl@opencrawl
```

ChatGPT: add the remote URL as a custom MCP connection in Plugins when your
account/workspace permits it. Developers can use the ZIP with the OpenAI plugin
submission portal. A GitHub release does not create an official directory listing.

Codex supports this repository's custom marketplace:

```sh
codex plugin marketplace add https://github.com/getopencrawl/opencrawl-plugins.git
codex plugin add opencrawl@opencrawl
```

Authorize in the host's connection UI, then ask: "Check my OpenCrawl connection."
Never paste a token or password into a conversation. Local CLI credential stores
can be separate from the ChatGPT/Claude cloud account connection.

## Data and permissions

The package contains static instructions and remote connection configuration.
It has no lifecycle hooks, local commands, transcript collector or embedded
credentials. A connection check sends an authenticated MCP request and returns
connection status, server time and revision. It does not upload the conversation
or inspect your files. Your host and the hosted service process connection and
account metadata under their own policies; this package is not a promise of
zero server logging. Hosted policy: https://app.getopencrawl.com/privacy.

For setup, limitations and support see
https://github.com/getopencrawl/opencrawl-plugins. Source is MIT licensed; hosted service
access and the rest of OpenCrawl are separate. Report non-sensitive problems in
GitHub issues; report vulnerabilities through GitHub private vulnerability reporting.
