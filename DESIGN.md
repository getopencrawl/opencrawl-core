# OpenCrawl design system

Soft paper: a quiet neutral canvas, white working surfaces, Geist type and
restrained periwinkle actions. `web/tokens.css` owns semantic light/dark colors,
fonts, spacing, radii, sizes and elevation. The hosted shell consumes these tokens.

Use Geist for UI/prose and Geist Mono for technical identifiers. Fonts are
self-hosted and retain `web/assets/Geist-OFL.txt`. Primary UI uses 14px, body
15px, labels 13px and metadata 12px. Controls use 6px corners, surfaces 12px.
Use 40px minimum desktop controls and 44px mobile/coarse-pointer targets, visible
keyboard focus and semantic HTML. Use `shadow-paper` for inset working surfaces.

Preserve automatic light/dark appearance and avoid local palette, font, radius
or shadow overrides. Core UI is only a greeting in this brick. Add shared
components when an actual product feature needs them.
