# Directory publication

GitHub distribution and official directory publication are separate.
This release has not been submitted to, approved by, or listed in either directory.
A custom marketplace is not the official directory.

## ChatGPT

Upload the release ZIP at https://platform.openai.com/plugins, select the verified
publisher identity, connect the remote MCP server, complete domain verification,
and resolve metadata, skill and tool scans. Supply reviewer access privately,
five positive and three negative test cases, a video walkthrough, accurate listing
assets, support/privacy information and policy attestations. Submit for review,
then publish after approval. A working preview with only a connection check does
not guarantee eligibility or acceptance.

## Claude

Submit `getopencrawl/opencrawl-plugins`, plugin path `opencrawl`, and tag `v0.1.1` at
https://claude.ai/directory/manage. The GitHub account connected in that Claude
organization must have push access. Validate the source, complete data handling
and compliance fields, submit, and publish when the review allows it. Submit the
remote MCP server separately as an MCP connector; use the same canonical URL.

The release ZIP can be uploaded privately and the repository can be added as a
custom marketplace before an official listing. Account/plan/workspace restrictions
and service admission still apply.

## Remaining launch evidence

Run live authorization and tool use on both platforms before claiming readiness.
Confirm refresh, revocation, a second device, reviewer access, and public admission.
Record the actual results, not proposed test cases. Complete the directory-specific
listing assets, review video and publisher/account verification in the portals.
Never put reviewer passwords or OAuth credentials in source or release archives.

Suggested preview scenarios: initial connection; repeat connection check; expired
access token refreshed by host; reconnect after revocation; product overview.
Negative scenarios: unavailable search; unauthorized account; request to reveal a
credential. These are proposed acceptance cases, not recorded successful runs.

Official references checked 2026-11-04:
- https://developers.openai.com/plugins/deploy/submission
- https://claude.com/docs/plugins/submit
- https://claude.com/docs/plugins/pre-submission-checklist
- https://claude.com/docs/connectors/building/submission
