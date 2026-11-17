# OpenCrawl web application

A reusable React operations console with strict TypeScript and one enforced
Night design system. Runtime adapters provide already-authorized data and pages.
The package does not depend on hosted identity or commercial services.

Install with `npm ci --prefix web-v2`; validate with `npm run check --prefix web-v2`.
The library build emits ESM and the combined stylesheet in `web-v2/dist`.
Consumers import the typed source entry and `src/styles.css` through the core
package exports, or bundle the generated library with their React runtime.
Fonts and the approved mark retain the existing `/assets/` deployment URLs.

Use AppRouter once, then AppShell with one NavigationItem array. Each route owns
only its content. Put focused onboarding routes outside AppShell; they share the
same router and design primitives. Onboarding's visual layout is preserved in its
single stylesheet. Operations pages use the shared layout vocabulary.

Architecture tests reject plain JavaScript source, explicit any, suppressed type
checking, inline styles, raw feature controls, duplicate navigation and hard-coded
internal anchor links. The CSS check restricts colors to canonical tokens and
feature styling to the shared system. These checks run with the normal test suite.

## Scoped stale-while-revalidate data

Wrap a multitenant console in `ConsoleDataProvider scopeKey={trustedScopeKey}`.
The runtime supplies a stable opaque key bound to its authenticated workspace,
user, session and role. A changed key replaces the memory-only cache and aborts
old reads. Never use a browser-selected workspace as authority. The single-tenant
AppShell supplies its own default provider. Consumers install the optional
`@tanstack/react-query` peer at the pinned web-v2 version.

`useConsoleResource` serves cached data on route return and revalidates stale
queries in the background. Initial reads retain loading/error/retry states; only
explicit server failures retain older data. Access errors clear the scoped
workspace. Reads are single-flight, hidden reads cancel, and mutations pause
polling and invalidate related queries. Usage keeps its one-minute cadence.
Pages load on demand through independent POST requests. Opening one page does
not start unrelated reports or block on their reads. Diagnostics readers and drafts use scoped
model entries; unfinished reads cancel on navigation, while completed results
and confirmed board history remain available.
