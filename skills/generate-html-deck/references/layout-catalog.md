# Layout Catalog

Read `assets/catalog.json`, then use the closest original fragment under `assets/layouts/` as a structure guide. Do not copy a layout wrapper around the service-owned slide root.

| Layout | Use for | Required named slots |
| --- | --- | --- |
| `cover` | Opening claim | eyebrow, title, subtitle, source, cover-image |
| `section-divider` | Narrative transition | section-number, title, summary |
| `two-column` | Paired evidence | title, left, right, source |
| `big-quote` | Verbatim statement | quote, attribution, source |
| `stat-highlight` | One primary metric | title, stat-value, stat-label, context, source |
| `kpi-grid` | Repeated measures | title, kpi-1 through kpi-4, source |
| `table` | Structured evidence | title, caption, table-head, table-body, source |
| `timeline` | Ordered milestones | title, phase-1 through phase-4, source |
| `comparison` | Two-sided contrast | title, left-heading, left-body, right-heading, right-body, source |
| `process-steps` | Operational sequence | title, step-1 through step-4, source |
| `image-hero` | Approved visual evidence | title, caption, source, hero-image |
| `thanks` | Closing takeaway | title, takeaway, contact |

Use `data-slot="name"` for content and `data-asset-slot="name"` for a structured image position. Do not place fallback URLs or unresolved `<img>` elements in a slot.

Name generated fragments exactly `slide-01.html`, `slide-02.html`, and so on. Record stable IDs in `process.json`; do not put `data-slide-root`, `data-slide-id`, or `data-source-refs` on a fragment because assembly owns those attributes.
