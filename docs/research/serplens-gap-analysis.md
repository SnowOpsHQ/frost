# frost vs SERP Lens: competitor gap analysis

Date: 2026-10-29. Competitor: SERP Lens 2.1.9 (macOS), from a third-party UI and package audit
(`serplens-surfaces-and-features.md` / `.json`, 29 Oct 2026) and an earlier reverse-engineering
report of 2.1.8 (the "RE report"). Both are treated as data. frost: this worktree (`chore/start-localhost`,
including uncommitted ChatGPT-route and left-dock work), read from `README.md`, `apps/desktop/README.md`,
`docs/plans/*.md`, `specs/*` and `apps/desktop/src/renderer/**`.

**Entry count.** The brief says 118 entries. The audit files hold **132** (`inventory_entry_count: 132`;
statuses Observed 100, Observed entry 5, Observed gated 6, Packaged only 10, Observed empty 7, Soon 4).
All 132 are covered below.

**Product context, as of today.** Every frost feature is free: no Pro tier, and an account is needed only
for sync. The SEO sidebar docks left. A "Sign in with ChatGPT" agent route is being built. Clean-room rule:
this document describes *capabilities* only. Nothing here is a reason to copy SERP Lens's code, prompts,
wording or assets (`docs/design/IMPLEMENTATION-PLAN.md` §1 anti-goals).

---

## 1. Summary

- **Coverage of the 132 entries:** **Has 36 · Partial 69 · Planned 3 · Missing 24**. Of the 24 Missing, 8 are
  not applicable to a free, local app (billing, seats, teams, team API keys, profile, debug menu).
- **Ahead:** security and privacy posture (the RE report found URL-scheme launch, permissions granted
  without asking, a permissive CSP added to pages, login CSRF and privacy toggles that do nothing; frost
  was built against each of these), local-first projects and screenshots, an append-only change
  history with lanes and retention, signed SERP selector packs, consented on-device intent,
  bring-your-own-key models, Linux and Windows builds, AGPL source, and every feature free.
- **At parity:** the core audit panels (On-Page, Links, Images, Social, Schema, Indexability, Speed,
  Compliance/a11y, JavaScript served-vs-rendered), devtools Redirects/Console/Issues, the command palette,
  the agent's chat, approvals, grants, MCP and skill editor, and the Changes diff.
- **Behind:** breadth of built-in AI workflows (3 vs 16), Search Console depth (no URL Inspection, no
  filters), rank tracking over time, AI-readiness scoring, the SERP-preview variants, the screenshot
  editor, page highlights and copy/export breadth, and anything that needs paid data (locations/VPN,
  keyword volumes, backlinks, AI-answer capture).
- **Best value next:** ship the ChatGPT route and remove the entitlement gating, then data-only built-in
  skills, then Search Console depth, then local rank tracking built on project captures (§3).

---

## 2. Coverage table (all 132 entries)

**frost status:** **Has** = built and specified. **Partial** = some of the entry is built, and the note
says what is missing or uncertain. **Planned** = in a plan or stubbed but not usable today (the plan is
cited). **Missing** = not built and not planned. "N/A" marks a Missing entry that makes no sense for a free,
local app.

**SERP Lens charge:** only where the audit or RE report gives evidence. "unknown†" means the RE report says
about 150 audit rules exist, 57 free and 93 Pro, but not which panel each belongs to. "credits (AI)" means
the audit observed AI-credit billing (SL-060, SL-113) and the RE report says the default model route is
SERP Lens's own server, billed to the user's account.

Paths in the evidence column are repo-relative. `R/` = `apps/desktop/src/renderer/`, `M/` = `apps/desktop/src/main/`.

### 2.1 Browser and navigation (13)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-001 | App shell (projects, screenshots, account, help, resizable panes) | Observed | unknown | Partial | Browser, left sidebar, agent panel, Projects/Screenshots/History/Settings sheets exist (`specs/seo-sidebar.feature.md`, `specs/agent-panel.feature.md`, `R/App.tsx`). Missing: Help, What's new, an account switcher, and resizable sidebar/agent panes (they have fixed widths; only the devtools drawer resizes). |
| SL-002 | Browser toolbar | Observed | unknown | Partial | Back/forward/omnibox/reload and a render-profile button (`specs/address-bar.feature.md`, `render-profile.feature.md`). No location control (see §4). Screenshots are taken from Changes/palette, not the toolbar. |
| SL-003 | Tabs (new/select/close/reopen) | Observed | unknown | Has | `specs/tabs.feature.md`, `browser-polish.feature.md` (reopen ≤ 20). Duplicate/close-others, which the audit saw only in packaged code, are not in frost either. |
| SL-004 | Browser menu (history, reopen, find) | Observed | unknown | Has | History menu, File › Reopen Closed Tab, Edit › Find (`M/menu.ts`). |
| SL-005 | New-tab dashboard | Observed | unknown | Partial | "Jump back in" tiles only (`R/components/StartView.tsx`, `browser-polish.feature.md`). No setup checklist, news or widgets. |
| SL-006 | Search destinations (Google/Bing/DDG/Perplexity/ChatGPT/AI Mode) | Observed | unknown | Partial | Google, Bing and DuckDuckGo only. AI engines in the address bar are out of scope in `docs/plans/phase-2.5-seo-tooling.md`. |
| SL-007 | Per-tab settings (device, UA, throttling, JS, CSS, cache, cookies, geolocation) | Observed | unknown | Partial | Render profiles cover device, UA (incl. Googlebot/Bingbot/custom), network, JS off, cache off and pin-to-site (`specs/render-profile.feature.md`). No CSS-off, cookie-off or geolocation override. |
| SL-008 | Google search settings (domain, hl, time, num, safe, pws, hide ads) | Observed | unknown | Partial | The SERP panel *shows* engine/query/gl/hl/device/page parsed from the URL (`serp-overlay.feature.md`). Project searches store country/language/device (`projects.feature.md`). There is no editor for these parameters. |
| SL-009 | Location picker (61 locations, 7 free) | Observed | plan-gated / usage (7 of 61 free; VPN usage on billing, SL-113) | Missing | Built-in VPN is a non-goal (`IMPLEMENTATION-PLAN.md` §1; `phase-4` decision 4). Alternatives in §4. |
| SL-010 | Site settings management | Observed entry | unknown | Partial | Per-origin pinned render profiles (≤ 200) and remembered permission Blocks exist. I found no list UI to review them; Clear Browsing Data forgets them all. |
| SL-011 | Page highlighting (links, headings, lazy images, keyphrases, all) | Observed | unknown | Partial | `HIGHLIGHT_MODES = off/links/headings/broken` (`specs/seo-sidebar.spec.ts`), plus SERP feature outlines. No lazy-image, keyphrase or highlight-all mode. |
| SL-012 | External analysis shortcuts | Observed | unknown | Partial | "Open in": Rich Results Test, mobile/desktop speed tests, HTML validator, archive lookup, and the site's robots.txt/sitemap (`OPEN_IN_TEMPLATES`, `specs/command-palette.spec.ts`). No Ahrefs/Semrush/Moz/Majestic/Similarweb/Whois/BuiltWith/site: search/Schema validator. |
| SL-013 | Advanced copy (24 choices) | Observed | unknown | Partial | 7 copy values (`COPY_VALUE_KEYS`), Copy links as CSV, Copy schema JSON, Copy snippet as HTML. All are written by main. |

### 2.2 Page analysis panels (29)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-014 | Panel selector + pins | Observed | unknown† | Has | 16 rail panels (`SEO_PANELS`, `specs/seo-sidebar.spec.ts`), docked left (uncommitted change to `seo-sidebar.feature.md`). No pin/unpin; every panel is always on the rail. |
| SL-015 | Analysis source (Rendered DOM / Raw HTML) | Observed | unknown† | Partial | Audits read the rendered DOM. The served HTML appears only in the JavaScript panel's diff (`seo-javascript.feature.md`). No per-report source toggle. |
| SL-016 | Overview (score, totals, page type, intent, quality) | Observed | unknown† | Partial | Score ring, band, counts, top issues, checks by category, render profile (`seo-sidebar.feature.md`). No page type or quality. Intent exists only on SERPs. |
| SL-017 | Alerts and findings | Observed | unknown† | Has | Each issue expands to why/fix/facts. The devtools Issues tab is a sortable table (`devtools.feature.md`). A "copy alerts" action was not found. |
| SL-018 | On-Page summary + metadata, AI rewrite | Observed | unknown†; rewrite = credits (AI) | Has | Pixel-width title/description checks (`seo-content.feature.md`). Rewrite is the `rewrite-title-meta` built-in skill (`specs/skills.spec.ts`). |
| SL-019 | Content quality (AI judgment) | Observed | credits (AI) | Missing | No automatic quality judgment. Users can ask the agent ad hoc. |
| SL-020 | Search targeting (GSC target queries, query→page check) | Observed gated | plan-gated (S04 "Upgrade to connect integrations") | Partial | A manual target query with a terms checklist (`seo-content.feature.md`) and GSC top-25 queries per page (`gsc-panel.feature.md`). They are not linked to each other, and nothing suggests a target from GSC. |
| SL-021 | Heading outline | Observed | unknown† | Has | Outline plus a headings highlight (`seo-rules.feature.md`, On-Page). A Tree/Depth toggle and copy-outline were not verified. |
| SL-022 | Keyphrases (1/2-word, indicators, highlights) | Observed | unknown† | Partial | 1–3-word n-grams with title/H1/meta/URL presence and CJK segmentation (`seo-content.feature.md`). No highlighting on the page. |
| SL-023 | Readability (Flesch, sentence length, difficult sentences, highlight) | Observed | unknown† | Partial | Flesch reading ease, English only. No sentence or word-complexity breakdown, no highlight. |
| SL-024 | Links (health, filters, bulk broken check) | Observed | unknown† | Has | Filters, CSV, highlight, and Check links (≤ 500, polite) (`seo-panels.feature.md`, `seo-checks.feature.md`). |
| SL-025 | Images | Observed | unknown† | Has | Alt, dimensions, oversized and lazy-in-first-screen rules, with filters. No image previews, by design: the chrome loads no remote images. |
| SL-026 | Social previews + tags | Observed | unknown†; AI write = credits (AI) | Has | OG and Twitter card previews and every field (`seo-panels.feature.md`). No Slack preview and no built-in "write social tags" skill. |
| SL-027 | Indexability / indexing (+ GSC index status) | Observed | unknown†; GSC part plan-gated | Partial | Combined verdict, canonical, robots/X-Robots-Tag, hreflang with return-link check (`seo-indexability.feature.md`). No GSC URL Inspection (index status, last crawl). |
| SL-028 | Crawling (bots, robots, sitemaps, raw robots.txt) | Observed | unknown† | Has | Googlebot/Bingbot/`*` verdicts, View robots.txt, Check sitemaps. AI bots come from Visibility probes. No WAF/firewall bot table. |
| SL-029 | AI readiness overview (score) | Observed gated | unknown† | Partial | Visibility probes over 6 agents compare status, robots, noindex, canonical, words and similarity (`visibility-probes.feature.md`). No readiness score, no llms.txt/agent-delivery checks, no assistant visibility. |
| SL-030 | AI assistant details (ChatGPT, Claude, Perplexity, Copilot, Google AI; roles) | Observed gated | unknown† | Partial | GPTBot, ClaudeBot and PerplexityBot only. No Copilot/Google-Extended, and no per-role tokens (search vs. training vs. user fetch). |
| SL-031 | Schema tree + validation | Observed | unknown† | Has | JSON-LD, microdata and RDFa in one tree, with frost's own required/recommended properties (`seo-schema.feature.md`). |
| SL-032 | Schema code view + copy | Observed | unknown† | Has | Raw view and Copy JSON per block. |
| SL-033 | Google rich results (GSC-backed) | Observed gated | plan-gated (GSC) | Partial | Own property checks for common types and "Open in" Rich Results Test. Nothing GSC-backed. |
| SL-034 | Page Speed (CWV, attribution, resources) | Observed | unknown† | Has | LCP/CLS/INP/FCP/TTFB, nav timing, resources and third-party share, live polling (`seo-speed.feature.md`). LCP/INP element attribution was not verified. |
| SL-035 | Compliance / security headers | Observed | unknown† | Has | `seo-compliance.feature.md`. |
| SL-036 | Compliance / accessibility | Observed | unknown† | Has | axe-core WCAG 2.0–2.2 A/AA (`seo-compliance.feature.md`). |
| SL-037 | JavaScript diff | Observed | unknown†; "Diagnose" = credits (AI) | Has | Per-field diff, verdict, 5 rules (`seo-javascript.feature.md`). No built-in "diagnose rendering" skill. |
| SL-038 | Raw vs rendered summaries | Observed | unknown† | Has | The same panel shows served and rendered values per field. |
| SL-039 | GSC page / site | Observed gated | plan-gated (S04) | Has | Page/property scope with automatic property match (`gsc-panel.feature.md`). No manual property picker. README still calls it "a Pro feature" (see Uncertainties). |
| SL-040 | GSC dates + filters | Observed | plan-gated (S04) | Partial | 7/28/90 days only. No calendar, country or device filter. |
| SL-041 | Changes timeline | Observed | plan-gated (RE: "Pro 'Changes' feature") | Partial | Capture now and project runs, lanes by profile and search parameters (`changes-capture.feature.md`). No automatic capture while browsing (scheduled captures are out of scope, `phase-6` plan) and no date-range filter. |
| SL-042 | Changes compare | Observed | plan-gated (RE) | Has | Diff grouped by region, word level (`changes-diff.feature.md`, `changes-panel.feature.md`). |

### 2.3 Search-result and AI-search contexts (4)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-043 | SERP features (composition, AI Overview, ownership, intent, highlights, download) | Observed | unknown | Partial | Composition including `ai-overview`, page-1 ownership with positions, intent chip, feature outlines (`serp-overlay.feature.md`, `SERP_FEATURE_TYPES`). No pixel depth, recent searches or data download. |
| SL-044 | SERP results (intent badges, copy, "what ranks") | Observed | unknown | Partial | A results list only. No per-result intent or site classification and no copy. |
| SL-045 | ChatGPT / AI Mode / Perplexity shortcuts from Google | Observed entry | unknown | Missing | Out of scope in the phase-2.5 plan. |
| SL-046 | AI-search analysis workspace | Packaged only | unknown (RE: drives ChatGPT/Perplexity/AI Mode in tabs) | Planned | `run_ai_search` is in the tool catalogue (`specs/agent-tools.spec.ts`), but its port answers "isn't connected in this build" (`M/agent/ports/serp-adapter.ts`). |

### 2.4 SEO developer-tools dock (8)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-047 | Elements (HTML/DOM/Diff, picker, search, copy source) | Observed | unknown | Partial | Inspector panel: a read-only DOM tree, picker, node details and SEO facts (`inspector.feature.md`). No source/diff views, DOM search or copy source. |
| SL-048 | Network (filters, waterfall, export/HAR, body search) | Observed | unknown | Partial | Filters, waterfall, robots verdict, allowlisted headers (`devtools.feature.md`). No export or HAR. Bodies are never read, by design. |
| SL-049 | Redirects (UA, trace again) | Observed | unknown | Has | Main-frame chain with headers. Use a render-profile UA or Visibility probes to re-trace as another agent. |
| SL-050 | Console | Observed | unknown | Has | Deduplicated, capped messages. |
| SL-051 | Storage (cookies, local, session) | Observed | unknown | Partial | Masked cookies and "Clear this site's data". No local or session storage. |
| SL-052 | Issues | Observed | unknown | Has | Every finding in one sortable table. |
| SL-053 | SERP preview: standard listing | Observed | unknown | Partial | Snippet editor: title/description drafts (≤ 6 per URL), desktop/mobile pixel cut, Copy as HTML (`seo-content.feature.md`). No site name, favicon, date, rating or breadcrumb, and no JSON-LD copy. |
| SL-054 | SERP preview: rich variants (Top Stories, Video, Recipe) | Observed entry | unknown | Missing | — |

### 2.5 AI panel and customization (15)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-055 | AI chat workspace | Observed | credits (AI) | Has | `R/components/agent/AgentPanel.tsx`, `AgentChat.tsx`, `AgentComposer.tsx`. Chats are bound to the active tab (`agent-panel.feature.md`). |
| SL-056 | Chat history (search, Active filter) | Observed empty | unknown | Partial | `AgentChatList.tsx`, ≤ 50 stored chats (`agent-data.feature.md`). No search or filter. |
| SL-057 | Chat lifecycle + export | Packaged only | unknown | Partial | Export to JSON/Markdown, delete, delete all, retention off/7d/30d/forever. No archive or rename. |
| SL-058 | Context picker (@ tabs) | Observed | unknown | Partial | Only the active tab is bound. No @-attaching of other tabs. |
| SL-059 | Model selection (Claude, Gemini, GPT, Grok) | Observed | credits (AI) | Partial | `ALLOWED_MODEL_IDS`: Claude Sonnet/Opus 5.5 and GPT-5/mini, through BYOK or Vercel AI Gateway. ChatGPT-plan models are in progress. No Gemini or Grok. |
| SL-060 | Model controls (reasoning, fast mode, AI credits, ChatGPT plan) | Observed | credits (AI); ChatGPT plan = the user's own plan | Planned | ChatGPT route: `docs/plans/agent-chatgpt-plan.md`, `specs/agent-chatgpt.*`. Main-side code is uncommitted (`M/agent/chatgpt/`) and the UI (Task 5) is not done. No reasoning-effort control. BYOK replaces credits. |
| SL-061 | Context usage meter | Observed entry | unknown | Has | `AgentContextMeter.tsx`. |
| SL-062 | Workflow picker (16 skills, Add Skills/MCP) | Observed | credits (AI) | Partial | Composer skill picker and palette "Run skill". Only **3** built-ins (`BUILTIN_SKILL_IDS`). |
| SL-063 | Skills library (search, enable/disable, import, new) | Observed | unknown | Partial | List, read-only built-ins, Duplicate to edit, user skills (`AgentSkills.tsx`). No enable/disable, import or search. |
| SL-064 | Skill editor | Observed | unknown | Has | Name, description, allowed tools, template with an allowlist of slots, inputs, inline errors (`skills.feature.md`, `agent-data.feature.md`). No Markdown preview. |
| SL-065 | MCP connection manager | Observed empty | unknown | Has | `AgentMcp.tsx`, `agent-mcp.feature.md`. Connections are labelled untrusted. No import. |
| SL-066 | MCP connection catalog (25 providers) | Observed | unknown | Missing | — |
| SL-067 | Custom MCP (local command / remote URL) | Observed entry | unknown | Has | stdio (one program, no shell, minimal env) and public `https:` with a bearer token. No MCP OAuth sign-in. |
| SL-068 | Permissions (always-allow, revoke, run JS without asking) | Observed | unknown | Has | Grants page (`AgentGrants.tsx`). `execute_javascript` can never be granted, which is deliberately stricter. |
| SL-069 | Tool approvals | Packaged only | unknown | Has | Approval cards that arm after a delay, per-site grants, MCP asks every time (`agent-approvals.feature.md`). |

### 2.6 Built-in AI workflows (16)

All of these cost AI credits in SERP Lens (SL-055/060). In frost a "Partial" here means: the agent has the
tools and a user can write this as a skill, but no built-in skill exists.

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-070 | Page Audit | Observed | credits (AI) | Has | `audit-this-page` (`packages/ai-skills/src/skills/builtins.ts`). |
| SL-071 | Title & Meta Rewrite | Observed | credits (AI) | Has | `rewrite-title-meta`. |
| SL-072 | Content Brief | Observed | credits (AI) | Partial | Tools: `page_text`, plus `serp_results` from a SERP loaded in the tab. |
| SL-073 | Full-page Rewrite | Observed | credits (AI) | Partial | `page_text`. Nothing writes back to a CMS. |
| SL-074 | Content Quality & Refresh | Observed | credits (AI) | Partial | `page_text`, `page_audit`. |
| SL-075 | Content Fact-Checking | Observed | credits (AI) | Missing | No web-search tool. `navigate` + `page_text` could visit sources one approval at a time, which is impractical. |
| SL-076 | Query-to-Page Mapping | Observed | credits (AI) | Partial | `gsc_performance` (one page at a time). |
| SL-077 | Internal Linking & Site Structure | Observed | credits (AI) | Partial | `internal-link-suggestions` built-in (`page_data.internalLinks`). No broken-link repair or topic clusters. |
| SL-078 | Schema Check | Observed | credits (AI) | Partial | `page_audit` carries schema findings. |
| SL-079 | Hreflang & International | Observed | credits (AI) | Partial | `page_audit` carries hreflang findings. |
| SL-080 | Rendering Check | Observed | credits (AI) | Partial | `page_audit` (JavaScript rules), `visibility_probes`. |
| SL-081 | Crawl & Indexability Check | Observed | credits (AI) | Partial | `page_audit`, `run_visibility_probes`. |
| SL-082 | Search Performance Diagnosis | Observed | credits (AI) | Partial | `gsc_performance`. |
| SL-083 | SERP Analysis | Observed | credits (AI) | Partial | `serp_results` reads only a SERP the user loaded (`serp-adapter.ts`). |
| SL-084 | AI Search Visibility | Observed | credits (AI) | Planned | Depends on `run_ai_search` (SL-046). |
| SL-085 | Keyword & Competitor Research (volume, CPC, KD, gaps) | Observed | credits (AI); data source unknown | Missing | No keyword data. No SEO-data vendor is reachable through frost's bearer-only MCP client today (§4). |

### 2.7 Projects and rank tracking (12)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-086 | Project library (cards, sort, favorite) | Observed | plan-gated (project quota, SL-087/113) | Partial | Projects sheet (`R/components/changes/Projects.tsx`, `projects.feature.md`). No favorites or sort. |
| SL-087 | Create project (domain, favicon, goal, competitors) | Observed | plan-gated (quota) | Partial | Name, pages, searches and an optional render profile. No root domain, goal or competitors. No quota. |
| SL-088 | Project actions | Observed | unknown | Partial | Capture now, retention, delete (which purges). Edit and per-project screenshots exist. There is no separate "Keywords" view; searches play that role. |
| SL-089 | Project workspace | Observed | unknown | Partial | One sheet. No per-project analysis sidebar. |
| SL-090 | Rank Tracker (positions, change, range) | Observed empty | credits (tracking usage, SL-091/113) | Partial | Saved searches are captured into SERP lanes on Capture now. Positions are visible only inside a capture's diff. No position table or trend. |
| SL-091 | Add keywords (bulk, tags, locations, schedule, device) | Observed | credits (estimate shown) | Partial | Search = engine + query + country + language + device. No bulk entry, tags or schedule. |
| SL-092 | SERP Compare (two keywords/dates) | Observed empty | credits (needs tracked keywords) | Partial | The Changes diff compares two captures of the *same* search lane. It cannot compare two keywords. |
| SL-093 | Project screenshot library | Observed empty | unknown (RE: stored server-side) | Partial | Screenshots are filed into a project (`R/components/changes/Screenshots.tsx`). Search was not verified. |
| SL-094 | Competitors | Soon | unknown | Missing | — |
| SL-095 | Tags | Soon | unknown | Missing | — |
| SL-096 | Site Structure | Soon | unknown | Missing | No site crawler. |
| SL-097 | Pages | Soon | unknown | Partial | Projects list pages, each with its change history. |

### 2.8 Screenshots (3)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-098 | Global screenshot library (search, project filter) | Observed empty | unknown | Partial | Gallery with thumbnails, preview, Reveal and Copy image (`screenshot.feature.md`). Search and project filter not verified. |
| SL-099 | Capture modes | Observed | unknown | Partial | Viewport, area, stitched full page. No app-window or desktop capture. |
| SL-100 | Screenshot editor (annotate, crop) | Observed | unknown | Missing | — |

### 2.9 Settings, accounts and teams (14)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-101 | Profile | Observed | unknown | Missing · N/A | The frost account exists only for sync. There is no profile. |
| SL-102 | Teams | Observed | seat-gated (seats on billing) | Missing · N/A | Local projects replace shared team workspaces. |
| SL-103 | Team/account switcher | Observed | unknown | Partial | Sign in/out in Settings, one account (`account-settings.feature.md`). |
| SL-104 | Appearance (theme, scale, font, palettes) | Observed | unknown | Partial | Light/dark follow the OS (`R/styles.css`, `prefers-color-scheme`). Themes are out of scope in the phase-2.5 plan. |
| SL-105 | Navigation + AI prefs (home view, ChatGPT, retention) | Observed | unknown | Partial | Chat retention exists. ChatGPT is Planned (SL-060). No default home view. |
| SL-106 | History settings (retention, clear by project/date) | Observed | unknown | Partial | Delete one, clear all, Clear Browsing Data. No retention period or date range. |
| SL-107 | Change-tracking settings (excluded URLs, ignored params) | Observed | plan-gated (RE: Changes is Pro) | Partial | SERP lanes use the canonical search URL, so tracking parameters are ignored. Per-project retention exists. No excluded-URL list or editable ignored parameters for pages. |
| SL-108 | Automatic AI checks (type/intent/quality/target) | Observed | credits ("per-check cost") | Missing | On-device intent covers SERP queries only. |
| SL-109 | Team general | Observed | unknown | Missing · N/A | — |
| SL-110 | Team people/roles | Observed | seat-gated | Missing · N/A | — |
| SL-111 | Invite members | Observed gated | seat-gated (upgrade gate observed) | Missing · N/A | — |
| SL-112 | Integrations (GSC accounts) | Observed | plan-gated (S04 "Upgrade to connect integrations") | Partial | One read-only GSC connection (`gsc.feature.md`). No multiple accounts or property count. |
| SL-113 | Billing / credits / top-up | Observed | paid (the billing surface) | Missing · N/A | Everything is free. AI runs on the user's key or ChatGPT plan. |
| SL-114 | Team API keys | Observed empty | plan-gated (S04 "paid plans") | Missing · N/A | frost has no server API. Agent keys are BYOK in the keychain. |

### 2.10 Command menu, history and support (11)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-115 | Command palette | Observed | unknown | Has | `command-palette.feature.md`; Mod+K, every action. |
| SL-116 | Browsing history (project filter, change count) | Observed | unknown | Partial | By day, search, open, delete one, clear all. No project filter or change counts. |
| SL-117 | What's new | Observed | unknown | Partial | The update notice shows plain-text release notes (`update-client.feature.md`). No release feed. |
| SL-118 | In-app Help | Observed | unknown | Missing | No Help menu (`M/menu.ts`). |
| SL-119 | Native app menu | Observed | unknown | Partial | About, Settings…, Clear Browsing Data, standard roles. Check for Updates is in the palette only, and only with a feed configured. |
| SL-120 | File menu | Observed | unknown | Has | New Tab, Open Location, Close Tab, Reopen Closed Tab. "New Project" is in the palette instead. |
| SL-121 | Edit menu | Observed | unknown | Has | Standard roles plus Find. |
| SL-122 | View menu | Observed | unknown | Partial | Reload/hard reload, zoom, SEO Sidebar, palette, SEO devtools. No dark-mode, SERP-preview or highlight entries. |
| SL-123 | History menu | Observed | unknown | Partial | Back/Forward, Show All History. No recent entries. |
| SL-124 | Window menu | Observed | unknown | Has | Minimize, zoom, front. |
| SL-125 | Help / troubleshooting (logs, install ID, reset, bug) | Observed | unknown | Missing | — |

### 2.11 Additional packaged or unverified surfaces (7)

| SL | Feature | SL status | SL charge | frost | Evidence / note |
|---|---|---|---|---|---|
| SL-126 | Keyboard shortcuts screen | Packaged only | unknown | Missing | — |
| SL-127 | Update preferences (channel, auto-install) | Packaged only | unknown | Partial | Toggle for automatic checks and Check for Updates (palette), a signed staged manifest. No channel choice. Unsigned builds install by hand. |
| SL-128 | Privacy / local data controls | Packaged only | unknown | Has | Two telemetry switches, off by default and actually wired (`telemetry.feature.md`), plus Clear Browsing Data. The RE report says SERP Lens's toggles are not wired. |
| SL-129 | Extra settings routes (defaults, shortcuts, privacy, updates) | Packaged only | unknown | Partial | The Settings sheet has Account, Search Console and Telemetry. Agent settings live in the panel. No shortcuts or updates page. |
| SL-130 | Context-menu exports (headings/links/images/speed/schema/social) | Packaged only | unknown | Partial | Links CSV and schema JSON only. The page context menu holds browse actions. |
| SL-131 | Import MCP/skills from Claude/Codex; browser-use permission | Packaged only | unknown | Missing | — |
| SL-132 | Debug crash menu | Packaged only | unknown | Missing · N/A | Not a user feature. |

**Totals:** Has 36 · Partial 69 · Planned 3 (SL-046, SL-060, SL-084) · Missing 24 (8 of them N/A: SL-101,
102, 109, 110, 111, 113, 114, 132).

---

## 3. Missing and partial features: value vs. cost, and build order

### 3.1 Excluded as not applicable, and how frost meets the need

| SERP Lens surface | Why excluded | How frost meets the need |
|---|---|---|
| AI credits, top-up, promo credits (SL-060, SL-113) | No billing in a free app | BYOK (Anthropic/OpenAI keys in the keychain), Vercel AI Gateway, and soon the user's own **ChatGPT plan** (`agent-chatgpt-plan.md`). There is no per-check cost, so automatic AI checks become a local switch, and the user's key or plan pays. |
| Teams, seats, invites, roles (SL-102, 109–111) | No server workspace | Local **projects**. Optional sync of change intelligence (`phase-7` plan) is the way to share between devices, not between colleagues. Sharing with others is through exports (CSV, chat Markdown/JSON, screenshots). |
| Team API keys (SL-114) | No hosted API | The data is local SQLite (`packages/db`). Planned MCP or CLI exposure could serve automation (not planned yet). |
| Plan quotas: project quota, 7 free locations (SL-009, SL-087) | No tiers | No quotas. Locations are a §4 problem, not a pricing one. |
| Profile, account switcher (SL-101, SL-103) | An account is only for sync | Sign-in stays in Settings for sync only. |
| Debug crash menu (SL-132) | Not a user feature | — |

### 3.2 Ranked backlog (value to an SEO practitioner vs. cost)

Value: H/M/L. Cost: S (≤ 1 task, data or UI only), M (a phase-like task set, new IPC or schema), L
(new subsystem or third-party dependency).

| # | Feature (SL ids) | Value | Cost | Why / what to build |
|---|---|---|---|---|
| 1 | Finish the **ChatGPT-plan route** and drop entitlement gating everywhere (SL-060, SL-105) | H | S | Main side is in progress. Tasks 5–6 (settings UI, composer notice, e2e) remain. Gating still lives in the specs (`pro` → `ai-agent`, `search-console`, `sync`; skills need `agent.skills`). Make those flags always on. |
| 2 | **Built-in SEO skill pack**: schema, hreflang, rendering, crawl/indexability, search-performance diagnosis, SERP analysis, content brief, quality/refresh, query→page, social tags, rendering diagnosis (SL-062, 072–083, 019, 026, 037) | H | S | Skills are data (`packages/ai-skills/src/skills/builtins.ts`). The tools exist. Grows `BUILTIN_SKILL_IDS` from 3 to about 12. Also add enable/disable, import of skill JSON, and search (SL-063). |
| 3 | **Search Console depth**: URL Inspection (index status, last crawl, rich results), custom range, country/device filters, query→page targets in Content (SL-020, 027, 033, 040, 112) | H | M | Uses the existing read-only scope and `M/gsc/`. URL Inspection reports index and rich-result status (check quotas). Multiple accounts later. |
| 4 | **Local rank tracking** from project captures: position table and trend per search, compare two searches or dates, bulk add, tags (SL-090–092, 095, 086–087) | H | M | Derive positions from the SERP snapshots already stored in `ci_versions`. No new data source. Unattended scheduling stays out of scope (see §4). An opt-in "capture while frost is open" timer is the middle ground. |
| 5 | **AI-readiness score**: more agents (OAI-SearchBot, ChatGPT-User, Google-Extended, Applebot-Extended, CCBot, Bytespider…), roles per bot, llms.txt and pre-render coverage, a score (SL-029, 030) | H | M | Extends `visibility-probes` and `seo-core` rules. The served-vs-rendered diff already measures pre-render coverage. |
| 6 | **Highlights + copy/export breadth**: keyphrase, lazy-image, external/internal highlights, all 24 copy values, CSV for images/missing alt/headings/speed (SL-011, 013, 022, 130) | M | S | `HIGHLIGHT_MODES`, `COPY_VALUE_KEYS`, and main-written CSV following the `seo.copyLinksCsv` pattern. |
| 7 | **SERP preview completeness**: site name, favicon placeholder, breadcrumb, date, rating, rich variants, copy JSON-LD (SL-053, 054) | M | S–M | Snippet editor (`SnippetEditor.tsx`, the pixel-width table). |
| 8 | **Devtools depth**: HAR/CSV export of the log, local/session storage, Inspector search and served/rendered source views (SL-047, 048, 051) | M | M | `M/devtools/`, `M/inspector/`. Bodies stay unread, so HAR has no bodies and must say so. Storage reads need a script in an isolated world. |
| 9 | **MCP presets catalog + wider models**: presets for known remote MCP servers (Semrush, Ahrefs, SE Ranking…, plus Linear/Notion/WordPress), Gemini/Grok through the Gateway, reasoning-effort control (SL-066, 059, 060, 085) | M | S | Presets are data, and connections stay untrusted. No SEO-data vendor ships among them: none is reachable through frost's bearer-only MCP client today (§4), so keyword, competitor and backlink data stays missing. |
| 10 | **Screenshot annotation editor**: arrow, box, text, crop, then save as a new hashed file (SL-100) | M | M | `M/screenshots/`. Must keep the hash-named, append-only file rules. |
| 11 | SERP param editor (hl/gl/num/time/safe/pws) and AI-engine destinations (SL-008, 006, 045) | M | S | Build URLs from parameters. Opening Perplexity/ChatGPT/AI Mode as ordinary tabs is cheap. Reading them is #15. |
| 12 | Readability depth: sentence length, difficult sentences, highlight, non-English formulas (SL-023) | M | S | `seo-core` content report. |
| 13 | Render profile extras: CSS off, cookies off, geolocation override (SL-007) | M | S | Add `Emulation.setGeolocationOverride` and cookie blocking to the CDP allowlist (`render-profile-debugger.ts`). Note: this is browser geolocation, not IP location. |
| 14 | Agent chat polish: history search, rename/archive, @-attach other tabs (SL-056–058) | M | S–M | `agent-data` store; the multi-tab context needs broker changes. |
| 15 | AI-search visibility: wire `run_ai_search`, AI-answer capture and citations (SL-046, 084) | H | L | Needs the user's sessions or provider APIs. ToS and prompt-injection risk (§4). |
| 16 | Overview page type, quality and automatic AI checks (SL-016, 019, 108) | M | M | An opt-in setting run on the user's key or plan. Page type could be on-device. |
| 17 | Site crawler: Pages and Site Structure (SL-096, 097) | H | L | A polite local crawl over the bounded fetcher. A large new subsystem. |
| 18 | Small polish: new-tab checklist, panel pins, resizable panes, history retention/filters, change-tracking exclusions, Help menu, shortcuts screen, What's new, export logs (SL-001, 005, 014, 106, 107, 116, 117, 118, 125, 126) | L | S | Each one is small. |

### 3.3 Suggested waves

| Wave | Contents (backlog #) | frost subsystems touched |
|---|---|---|
| **1 — Free and AI-complete** (S) | #1 ChatGPT route + ungating; #2 skill pack; #9 MCP presets and models; #12 readability | `M/agent/` (chatgpt, session, model-proxy, settings), `apps/agent-runtime`, `packages/ai-skills`, `M/account/` entitlements, `specs/agent-*`, `specs/skills.spec.ts`, `R/components/agent/*` |
| **2 — Search Console + AI readiness** (M) | #3 GSC depth; #5 AI-readiness score; #16 opt-in page type | `M/gsc/`, `specs/gsc*.ts`, `R/components/seo/GscPanel.tsx`, `Content.tsx`, `Indexability.tsx`, `M/serp/` probes, `packages/seo-core` rules, `specs/visibility-probes*` |
| **3 — Projects as a workspace** (M) | #4 local rank tracking; #11 SERP params; project polish (favorites, tags, competitors) | `packages/change-intel`, `packages/db` (`ci_*` read models), `M/changes/`, `R/components/changes/*`, `M/serp/` (params), `specs/projects*`, `changes-*` |
| **4 — Practitioner tooling** (S–M) | #6 highlights/exports; #7 SERP preview; #8 devtools; #10 screenshot editor; #13 render-profile extras; #14 chat polish; #18 | `M/seo/` (highlight, copy), `packages/seo-core` copy values, `R/components/seo/SnippetEditor.tsx`, `M/devtools/`, `M/inspector/`, `M/screenshots/`, `M/browser/render-profile-debugger.ts` (+ Semgrep allowlist) |
| **5 — Big bets** (L) | #15 AI-search capture; #17 site crawler; BYO SERP/location APIs (§4) | `M/agent/ports/serp-adapter.ts`, `M/serp/`, `M/seo/fetcher.ts` (a new crawl lane), `packages/db`, plus new secret slots in the keychain store |

---

## 4. Features that depend on paid third-party data

| Need (SL) | How SERP Lens appears to do it | Options for a free, open-source frost | Risks |
|---|---|---|---|
| **Rank tracking** (SL-090–092) | Server-side tracking billed as credits, with a daily/weekly/monthly schedule (audit; RE: "rank tracking … live on the server") | (a) **Local captures** (exists): a project run loads each search in a visible tab from the user's IP. Add positions and trends (#4). (b) **GSC average position** for the user's own sites: free, but an aggregate. (c) **BYO SERP API key** (DataForSEO, SerpApi, Serper, Bright Data…), stored like agent keys, fetched by main, parsed into the same `SerpSnapshot` schema. (d) MCP to the user's Semrush/Ahrefs/SE Ranking position tracking (not reachable today: see the note under this table). | (a) Google ToS on automated queries, CAPTCHAs and consent walls (already captured "as is"), personalization and IP-based location, and the app must be open. (b) Sampled, delayed about 2 days, own properties only. (c) Cost lands on the user's key, vendor parsing differs, and a hosted key is a secret (keychain rules). (d) Untrusted MCP output, and a subscription is needed. |
| **SERP locations / VPN** (SL-009, SL-002) | Built-in VPN with 61 locations, 7 free, usage billed (audit; RE: "built-in VPN") | (a) `gl`/`hl` (and Bing `cc`/`setlang`) parameters in a search editor (#11). (b) Google's `uule` location parameter (undocumented). (c) **User-supplied proxy** per tab or partition (Electron `session.setProxy`) with credentials in the keychain. (d) The user's own system VPN. (e) A BYO SERP API's location field (c above). (f) Browser geolocation override (#13), which affects only sites that ask for it, not search location. | (b) Undocumented and may break silently. (c) The proxy sees all traffic in that partition, so it must be scoped to a dedicated partition. Proxy resolution also widens the DNS gap the README already documents. A built-in VPN is a non-goal (`IMPLEMENTATION-PLAN.md` §1). |
| **Keyword volume / CPC / difficulty, competitors** (SL-085, SL-094) | An agent "keyword data" tool (RE). Data source unknown | (a) GSC queries and impressions for own sites (exists). (b) MCP presets for Semrush, Ahrefs, SE Ranking or SISTRIX on the user's subscription (#9) (not reachable today: see the note under this table). (c) BYO Google Ads Keyword Planner API (needs an Ads account and developer token) or DataForSEO. (d) Autocomplete/"related searches" from loaded SERPs (exists as composition). | (b)/(c) Cost and rate limits on the user's account, and output is untrusted text into the agent. (a) Own sites only. |
| **Backlinks** (not in SL's UI; Ahrefs/Semrush/Majestic shortcuts SL-012, MCP catalog) | External shortcuts and MCP providers | (a) "Open in" shortcuts to the vendors' public pages (cheap, #6). (b) MCP to Ahrefs or Semrush (not reachable today: see the note under this table). (c) Bing Webmaster Tools data for verified sites (check the API before committing). (d) Common Crawl's web graph (large, offline, coarse). The Search Console API has no links report. | Third-party ToS. Partial coverage. Untrusted data. |
| **AI-search visibility** (SL-046, SL-084, SL-029/030) | `run_ai_search` drives ChatGPT, Perplexity and Google AI Mode in tabs using the user's sessions (RE) | (a) The same approach: an approval-gated tool that opens the engine in a tab the user is signed into and reads the answer in an isolated world with signed selector packs (as for SERPs). (b) BYO provider search APIs (for example Perplexity's API, or OpenAI's web search tool on the user's key). (c) Probe-only "can the bot reach me" (exists: Visibility probes). | (a) Engine ToS, account bans, UI churn (needs pack updates), and a hostile answer steering the agent (keep it untrusted, approval-gated, never grantable, as the specs already say). (b) Cost, and API answers differ from the consumer UI. |
| **Google rich-result eligibility / index status** (SL-027, SL-033) | GSC-backed, plan-gated | GSC URL Inspection on the existing read-only scope (#3). It is free but quota-limited, own properties only. | Quota and delay. The connection is per frost profile. |

**MCP and SEO-data vendors.** The MCP options above (Rank tracking (d), Keyword (b), Backlinks (b))
are not reachable today. frost's MCP client sends a token only as `Authorization: Bearer` and has no
MCP OAuth sign-in, and no SEO-data vendor's server can be used that way (`MCP_DEFERRED_PRESETS` in
`specs/agent-mcp-presets.spec.ts` lists each with its source):
- **Ahrefs**: its terms forbid standalone HTTP/JSON-RPC clients on its MCP endpoint.
- **Semrush, SE Ranking, DataForSEO**: their keys go in non-Bearer headers (`Authorization: Apikey`,
  `X-Api-Key`, and HTTP Basic).
- **SISTRIX**: OAuth sign-in only.

A custom API-key header field for MCP servers would unlock Semrush and SE Ranking. That is a
follow-up, not yet planned.

---

## 5. Where frost is ahead of SERP Lens

Claims about SERP Lens come from the audit and RE report. "Not seen" means not in the audit, which does
not prove SERP Lens lacks it.

| Area | frost | SERP Lens (evidence) |
|---|---|---|
| Browsing security | Tabs navigate only to `http(s)`/`about:blank`. `mailto:` opens only on a gesture. No `app://`/`file:` from tabs. Popups need a gesture (`README.md` Security model) | RE (High, confirmed at runtime): any page can launch arbitrary URL schemes with no prompt |
| Permissions | Deny by default, per (origin, top-level) pair, prompt buttons arm after a delay (`permissions.feature.md`) | RE: every permission except geolocation is granted automatically |
| Page integrity | Never changes a page's CSP, DOM or globals. Audits run in isolated worlds | RE (confirmed at runtime): adds a wide-open CSP to pages that have none |
| Sign-in | Loopback + PKCE + an in-app "Confirm sign-in" with a code (`account-signin.feature.md`) | RE: `serplens://login?token=` deep link signs in with no confirmation (login CSRF) |
| Privacy / telemetry | Off by default, two working switches, scrubbing, no identifiers (`telemetry.feature.md`) | RE: Privacy toggles not wired, PostHog identifies by email, a server flag can export AI chats |
| Data locality | Projects, screenshots, change history and chats are all local SQLite/files, with retention, purge preview, disk usage and Compact (`retention.feature.md`) | RE: projects, rank tracking and screenshots live on the server |
| Change history integrity | Append-only (trigger-enforced), lanes keyed by render profile and search parameters, diff by region (`capture-db.feature.md`, `changes-diff.feature.md`) | RE: append-only local DB, 12-month retention, tagged with install/user/team IDs. No user-set retention seen |
| AI model choice and cost | BYOK (Anthropic/OpenAI), Vercel Gateway, and the ChatGPT plan (in progress). Keys never leave main (`agent-proxy.spec.ts`) | Credits by default through its own server. A ChatGPT plan route through a managed Codex CLI (RE) |
| Agent safety | `execute_javascript` asks every time and can never be granted. Tool output is marked untrusted. Skill slots are sanitised. MCP refuses private addresses and runs no shell (`agent-mcp.feature.md`, `skills.feature.md`) | Optional "Run JavaScript without asking" (SL-068). RE: the MCP "add server" handler has no sender check |
| SERP reading | Signed, updatable selector packs, with honest "couldn't read this layout" instead of a guess (`serp-selector-pack.feature.md`) | Not seen |
| Intent classification | On-device, downloaded only after consent, hash-pinned, with confidence shown (`intent-classifier.feature.md`) | RE: bundled on-device embedding model. Consent flow not seen |
| Crawler comparison | Fetch as six agents side by side, with differences marked (`visibility-probes.feature.md`) | AI readiness gated / "not checked" in the audit |
| Render profiles | Pin to site, crawler UAs with client hints, CDP allowlist, always-visible badge/frame (`render-profile.feature.md`) | Per-tab settings exist (SL-007); no comparable visibility cues seen |
| Snippet drafts | Up to 6 saved drafts per URL with pixel-width previews | Editable preview (SL-053); saved drafts not seen |
| Content internationalisation | `Intl.Segmenter` word counts and n-grams for CJK/Thai | Not seen |
| Updates | Ed25519-signed, staged manifest, nothing downloaded without a click | Standard update entry (SL-119) |
| Platforms and licence | macOS, Linux (AppImage, deb) and Windows builds verified in CI. AGPL-3.0. Every feature free | The audit covers a macOS build only (other platforms not checked). Paid plans, credits and seats |

---

## 6. Uncertainties

- **132 vs. 118.** The brief's count does not match the audit files (132). Either the brief refers to an
  older audit or it excluded some sections. All 132 are scored here.
- **Pricing per feature is mostly unknown.** The RE report gives a rule split (57 free / 93 Pro) but no
  per-panel mapping. "Plan-gated" for GSC rests on one packaged string ("Upgrade to connect
  integrations", S04). The audit's GSC connection worked with zero properties, which may mean a trial.
- **SERP Lens "Observed" ≠ working.** The audit ran no AI prompts, tracking, exports or GSC reports, so
  parity claims compare against labels and screens, not tested behaviour.
- **frost statuses read from specs and code, not from a running app.** These were not verified: copy-alerts
  in Overview, a Tree/Depth heading view, LCP/INP element attribution, screenshot gallery search or
  project filter, and a list UI for pinned site profiles. They are marked conservatively.
- **The free decision is not yet in the repo.** `apps/desktop/README.md` (GSC "a Pro feature"),
  `specs/entitlements.feature.md` (`pro` → `ai-agent`, `search-console`, `sync`) and `skills.feature.md`
  (`agent.skills` entitlement) still gate. Wave 1 #1 assumes they will be ungated.
- **The left dock is partly specified.** `specs/seo-sidebar.feature.md` (uncommitted) says the sidebar docks
  left. `specs/agent-panel.feature.md` still describes the row as "page | agent | SEO sidebar". Not
  material to this analysis, but the specs disagree.
- **The ChatGPT route** is uncommitted work in progress (main-side `M/agent/chatgpt/` exists, the settings
  UI does not). Its open questions (namespace tool groups, plan eligibility) are in the plan.
- **Third-party options in §4** (SERP APIs, `uule`, Bing Webmaster backlinks, URL Inspection quotas) are
  named from general knowledge and were not checked against current vendor docs. Check before
  planning.
- **No SERP Lens code or assets were used.** Only the two audit documents. Any feature taken from §3
  must be specified in frost's own words (clean-room, `CONTRIBUTING.md`).
