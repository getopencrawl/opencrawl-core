# OpenCrawl design system

Night: the getopencrawl.com look. A plain black canvas, near-black panels with hairline borders, Geist type,
and buttons in the OC mark's style. `web/tokens.css` owns colors, fonts,
spacing, radii, sizes and elevation; `web/frame.css` owns the page frame (glass header, brand lockup, content column); `web/controls.css` owns
buttons and focus. The existing hosted shell consumes these shared assets.

Primary actions use a plain lavender face (`--primary`) at rest, with no layers.
Only hover reveals coral and cobalt at the sides (`--logo-layers-wide`) and
brightens the face over 160ms. The layers disappear on pointer exit and press.
This is the shared default in `web/controls.css` for buttons and
links. Split controls put the layers around their outer edge, including when
either segment is hovered; their internal divider stays unchanged. Secondary actions use the
muted indigo `.secondary` treatment. Panels use `--surface`, `--line` and
`--radius-panel`.

Use Geist for UI/prose and Geist Mono for technical identifiers and copyable
commands. Fonts are self-hosted and retain `web/assets/Geist-OFL.txt`. Display
headings are 600 weight with tight tracking (`--tracking-display`); UI uses
14px, body 15px, labels 13px and metadata 12px. Controls use 6px corners,
surfaces 12px. Use 40px minimum desktop controls and 44px mobile/coarse-pointer
targets, visible keyboard focus and semantic HTML.

The product is dark only, like the landing page. Avoid local palette, font,
radius or shadow overrides; add tokens here instead. Add shared components when
an actual product feature needs them.


## Guided onboarding

Three focused steps share `renderOnboardingShell` and `renderDocument`: agent
setup, Sources, and optional teammate invitations. Keep a 640px boxed panel,
left-aligned headings and content, the bounded 960px top bar and outside-panel
navigation. Use existing circled checks, spinners and chevrons. No decorative
rules, auto-advancement or reveal/hide animation. Headings omit terminal periods.

Show the instruction for the next missing receipt. The first screen retains the
full grouped checklist, setup action and description after all gates turn green;
Next appears at the right below the panel. CLI and MCP sign-in are human steps;
the MCP test is an agent step. Recording contains first-session and optional
history subitems. Historical imports cannot prove live recording.

Prompt copy and reveal are independent split-button controls. Copy feedback
changes only the label for 1.5 seconds. The divider remains stable on either
segment's hover. Disclosures brighten their text and adjacent chevron on hover;
copy bars span their instruction width with a fixed right-hand feedback area.

Sources uses compact horizontal tiles with rounded-square provider logos on the
left, labels in the middle and plus/check marks at the right. Hide catalog search
below fifteen providers. API-key entry uses a named, focused dialog; OAuth returns
to the same Sources screen. Next becomes available after a confirmed connection.

Teammates appear in simple rows above one email field and Invite button. Enter
adds one teammate, clears the field and returns focus for another. Keep errors
beside the field. No redundant Ready labels. Skip for now and Open workspace
finish onboarding; invitations never become a gate.

Back and forward arrows have matching 21px outer insets. Preserve the primary
button's plain lavender rest state with coral/cobalt peeking out only on hover.
All receipts, connections and search results come from the runtime adapter;
there are no prototype variants, demo data or state controls in the product.
See [the behavior contract](docs/onboarding.md) and [QA](docs/onboarding-qa.md).
