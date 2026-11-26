# UI direction

frost's interface is its own design. This note records the direction it follows; no UI assets,
screenshots or markup from other products are kept in this repository. The colours, type (Geist,
bundled) and spacing are the tokens in `apps/desktop/src/renderer/tokens.css`
(`specs/design-tokens.feature.md`).

## Surfaces
- **Shell:** one chrome row (back, forward, reload, the tab strip, new tab, the address bar and the
  toolbar toggles) over the page, with a docked, collapsible, resizable SEO sidebar and an SEO
  devtools drawer. The agent panel
  is summoned on demand, so the page gets room by default.
- **SEO panels:** Overview; On-Page; Content; Links; Images; Social; Schema; Indexability; Page
  Speed; Compliance; JavaScript; SERP; Visibility; Search Console; Changes; Inspector.
- **Sheets in the page column:** the command palette, History, Projects, the screenshot editor, Site
  crawl, AI answers, Diagnostics, What's new, Settings and Help (keyboard shortcuts).
- **Settings sections:** Account, Search Console, Data sources, Locations, AI checks, Telemetry and
  History.

## Principles
- A persistent, scannable panel rail showing per-panel status (pass / warn / error) at a glance.
  Panels you do not use can be unpinned into a "More panels" menu, whose dot shows the worst status
  inside it.
- Every panel follows the Overview pattern: health score → ranked issues → how to fix.
- Page-derived content is always shown as inert text.
