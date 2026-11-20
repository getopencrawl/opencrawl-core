# Context suggestions: extending a self-hosted deployment

`POST /api/context/suggestions` accepts a human prompt and returns up to five
source quotations. Self-host runs the lexical reference judgment by default:
no model key, OpenCrawl account, credits or outbound hosted telemetry is required.
The cloud supplies its private judgment policy and billing around the same core
operation; those prompts and commercial rules are not in this repository.

## Replace the judgment

Create `context-judgment.mjs` beside your checkout's `package.json`. This working
example favors recent candidates while preserving the lexical planner and ranker:

```js
import {lexicalCheckJudgment} from './dist/src/search/check.mjs';

export function judgment() {
  const base = lexicalCheckJudgment();
  return {
    ...base,
    version: 'recent-first-v1',
    async shortlist(input, candidates, signal) {
      signal.throwIfAborted();
      return [...candidates]
        .sort((a, b) => String(b.provenance?.timestamp ?? '')
          .localeCompare(String(a.provenance?.timestamp ?? '')))
        .slice(0, 12).map(candidate => candidate.key);
    },
  };
}

// Optional: send these metadata reports to your own observability system.
export async function observe(principal, events) {
  console.info(JSON.stringify({event: 'context_suggestions',
    tenant: principal.tenantId, stages: events.map(event => event.stage)}));
}
```

Run the normal self-host server with
`OPENCRAWL_CONTEXT_SUGGESTIONS_MODULE=/absolute/path/context-judgment.mjs`.
Mount that file and its dependencies into a container when using Docker. The
module is trusted operator code, loaded once at startup; restart to change it.
An invalid or missing configured module stops startup instead of silently using
another provider. Existing self-host configuration and authentication still apply.
For embedded applications, pass `{contextSuggestions: {judgment, observe}}` to
`selfhostApplication` directly.

The public `CheckJudgment` type is exported from
`@getopencrawl/opencrawl-core/search/check`. A fresh factory instance receives
three bounded phases: `plan(input, signal)` returns search queries;
`shortlist(input, candidates, signal)` returns candidate keys; and
`rank(input, candidates, signal)` returns `{key, quote, score}` selections.
Use your own model client inside those functions, with credentials held only on
the server. There is no Jev-key onboarding requirement. Within a model call,
batched questions must be independent; combine their answers in application code.

Core caps three searches, 24 candidates, 12 ranked passages, five returned
quotations and 1,600 output tokens. The HTTP deadline is 20 seconds. Your adapter
must propagate `signal` and enforce its own token, call, retry and dollar ceilings;
core's input/output bounds alone do not cap a provider's internal spend.
Core retains current-chat exclusion, source visibility checks, exact-quote
validation and final authorization. An adapter cannot grant access to sources.

## Configure and study suggestions

Supported clients selected to record new sessions run the trusted plugin's
suggestion hook by default. Run `opencrawl context-suggestions status --api https://your-host`
to inspect the effective clients. Use `disable --harness claude-code` or
`enable --harness claude-code` on the same command and endpoint to override that
client. Existing saved selections survive the upgrade.

`POST /api/context/suggestions/events` accepts bounded metadata batches through
the same authentication boundary. `observe` receives observed/skipped/requested/
received/handoff/dropped events and optional feedback. No prompt, quotation,
credential or arbitrary log attributes belong in this contract. Without an
observer, self-host acknowledges and discards reports. The client outbox retains
at most 512 events for 24 hours and retries on eligible hooks; telemetry is best
effort. Disabled, excluded, unsupported and untrusted hooks are outside its
observation denominator. A `handoff` means stdout was written for the harness;
it does not prove model consumption or usefulness. Unreported outcomes are unknown.

After assessing a cloud receipt, optional explicit feedback is:
`opencrawl context-suggestions feedback --harness claude-code --check UUID --rating useful --source user`
(use `--source agent` for an agent assessment, optionally `--result 0` for the first
snippet). Ratings also include `irrelevant`, `distracting`, `stale` and `duplicate`.
Keep these labels separate from model scores and report labeling coverage when
calculating quality. Self-host observers can choose their own receipt/feedback
storage; the default lexical response does not create a billable receipt.
