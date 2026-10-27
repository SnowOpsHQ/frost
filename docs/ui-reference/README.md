# UI direction

frost's interface is its own design. This note records the direction it follows; no UI assets,
screenshots or markup from other products are kept in this repository.

## Surfaces
- **Shell:** browser chrome with a docked, collapsible SEO sidebar; an AI panel (later phase) that is
  summoned on demand, so the page gets room by default.
- **SEO panels:** Overview; On-Page (content, links, images, social); Schema; Indexability; Page
  Speed; Compliance; later: SERP, AI readiness, Search Console, Changes.
- **App views (later phases):** Projects, Screenshots.
- **Settings (later phases):** Profile, Teams, Preferences, Browser, General, People, Integrations,
  Billing, API keys.

## Principles
- A persistent, scannable panel rail showing per-panel status (pass / warn / error) at a glance,
  rather than a hidden panel menu.
- Every panel follows the Overview pattern: health score → ranked issues → how to fix.
- Page-derived content is always shown as inert text.
