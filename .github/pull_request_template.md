## Change

Describe the problem and resulting behavior.

## Architecture boundary

- Placement: core / optional adapter / CLI / coordinated core and shell. Why?
- Companion shell change, if applicable:
- [ ] The product remains usable on one customer's infrastructure without WorkOS, an OpenCrawl account, or the proprietary shell.
- [ ] New required contracts have a working single-tenant adapter; hosted provider details stay outside domain logic.
- [ ] Data-bearing operations enforce trusted scope and have negative authorization tests (or explain why not applicable).
- [ ] `ARCHITECTURE.md`, packaging and self-host instructions match the implemented behavior.

## Validation

Core/CLI/adapter checks, self-host evidence, and remaining limitations.
