# Remote MCP registry record

`server.json` describes the existing hosted MCP service. Its version is the
registry metadata version, separate from the portable plugin and CLI versions.
It includes no local package or credentials.

Review the exact JSON before upload. The manually dispatched
`.github/workflows/mcp-registry.yml` workflow publishes from core's main branch
using GitHub OIDC and checks that the input SHA-256 matches the reviewed file.
Merging the file or workflow does not publish a registry entry.

For local preparation, validate against the declared JSON Schema offline.
`mcp-publisher validate` sends the candidate to the remote registry and therefore
belongs after upload approval. Keep the submission receipt and verify the exact
version at the public registry API after publishing.

Organization namespaces cannot currently use the publisher's interactive GitHub
device login. GitHub Actions OIDC avoids copying an owner's GitHub token into
another tool. See the official
[authentication guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
and [workflow guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx).
