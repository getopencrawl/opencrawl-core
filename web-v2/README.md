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

## Single-tenant console

The included adapter runs against the authenticated core standalone MCP runtime.
It provides real scoped search, passage fetch and the registered-agent directory.
It does not invent hosted billing, team or managed-source capabilities. Start the
core MCP runtime with its documented search configuration, then set separate
random secrets of at least 32 characters:

```sh
export OPENCRAWL_MCP_URL=http://127.0.0.1:8093
export MCP_TOKEN='the existing standalone MCP token'
export OPENCRAWL_WEB_PASSWORD='a separate strong console password'
npm run build --prefix web-v2
npm start --prefix web-v2
```

The console listens on loopback port 8094. Authenticate as `opencrawl` with the
console password. Upstream tokens stay server-side. The upstream fixes identity;
browser requests cannot choose a tenant or proxy target. All data and assets need
authentication, cross-origin requests are denied and APIs accept bounded inputs.
For remote use, put an authenticated HTTPS reverse proxy in front and set
OPENCRAWL_WEB_ORIGIN to its canonical HTTPS origin before exposing HOST beyond
loopback. Never expose HTTP Basic credentials on an unencrypted public endpoint.
Keep the upstream token scoped to the intended single-tenant runtime. Replacing
server configuration requires restart; source content and indexes remain owned
by the existing core services. The adapter adds no database or persisted secrets.
