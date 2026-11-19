# Working on the OpenCrawl console

Before editing, identify what the person is trying to do in the affected state.
Open the target and the closest shipped example of that interaction. The
[console design guide](../DESIGN.md#components) points to the components,
callers and browser fixtures for each screen. Start with the matching entry.

Reuse the whole pattern and its default controls. For example, change a connector
card shared by Usage and Integrations in `IntegrationCard`. Check both callers.
Add a variant only when the interaction requires a difference.

For a layout change, render the affected state beside its reference at the same
desktop and phone widths with comparable data. Check edges, dividers, control
size and the next action. When two screens should align, measure one against
the other, as the [Search test](test/search.browser.spec.ts) does with Sessions.
If the requested behavior changes an old expectation, update the test with it.

## Implementation and checks

- The [route registry](src/application/app.tsx) feeds AppShell. Use the shared
  router for internal navigation. Settings sections embed in its existing Page.
- Use strict TypeScript, shared [React controls](src/design/components.tsx)
  and core styles. Render captured content through the shared Markdown renderer.
  Server authorization owns access decisions. See [architecture](../ARCHITECTURE.md)
  and [library behavior](../docs/sessions-and-memories.md).
- Use scoped data hooks for display reads. Keep the frame and last authorized
  content visible on refresh. Clear it on access loss. Preserve busy, error,
  keyboard and focus behavior. See [data and build instructions](README.md).
- From the repository root run `npm run check --prefix web-v2` and
  `npm run test:browser --prefix web-v2`. The architecture checks cover raw
  controls, navigation, styling and UI text, including centered-dot separators.
