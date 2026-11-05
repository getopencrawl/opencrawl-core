# OpenCrawl design system

Night: the getopencrawl.com look. A pure black canvas behind a faint coral,
cobalt and lavender grid, near-black panels with hairline borders, Geist type,
and buttons in the OC mark's style. `web/tokens.css` owns colors, fonts,
spacing, radii, sizes and elevation; `web/frame.css` owns the page frame (grid
backdrop, glass header, brand lockup, content column); `web/controls.css` owns
buttons and focus. The hosted shell consumes all three.

Primary actions use the lavender face (`--primary`) with hairline coral and
cobalt layers (`--logo-layers`) that widen on hover. Secondary actions use the
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
