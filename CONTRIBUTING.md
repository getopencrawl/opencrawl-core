# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Read [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md). Core must stay
  usable without the hosted service: never import hosted-only code or require an
  OpenCrawl account.
- For anything larger than a bug fix, open an issue first so we can agree on the
  approach.
- Report security problems privately; see [SECURITY.md](SECURITY.md).

## Making a change

```sh
npm ci
npm test
```

Use Node 24. For CLI changes, also run `bun run --cwd cli typecheck` and
`bun test cli`. Plugin changes live in `plugins/` and are exported to
[getopencrawl/opencrawl-plugins](https://github.com/getopencrawl/opencrawl-plugins);
run `node plugins/scripts/validate.mjs` and `node --test plugins/test/*.test.mjs`.

In the pull request, say where the change belongs (core runtime, CLI, plugin or
integration) and how you tested it. Add tests that fail closed for any change
that reads or writes user data. Keep new dependencies to a minimum; the boundary
test in `test/boundary.test.mjs` lists the ones core allows.

Never commit tokens, `.env` files, session transcripts or customer data.

By submitting a contribution you agree to license it under the
[Apache-2.0 license](LICENSE), or MIT for files under `plugins/`.
