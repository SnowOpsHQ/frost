# Phase 8 — Free and AI-complete (gap-analysis Wave 1) Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. Commit one conventional commit per task only when the lead asks. Tasks 2
> (the page painter), 6 (skill files from disk), 7 and 8a (the model proxy's allowlists and its
> reasoning check) and 10 (presets that pre-fill servers and commands) get a **security-focused
> review**. Steps use checkbox (`- [ ]`) syntax for tracking. Order: 1 → 2; 1 → 3 → 4 → 5 → 6;
> 7 → 8a → 8b → 9; 10 independent; 11 last.

**Goal** (what the user sees at the end):
- The agent's skill picker lists **14 built-in SEO skills** (3 today) in four groups (Page,
  Content, Technical, Search). The eleven new ones: content brief, page rewrite, content quality,
  query matching, structured data, hreflang, rendering, crawl and indexing, search performance,
  SERP analysis and social tags.
- The skills library can be **searched**, any skill (built-in or the user's) can be **turned off**
  (it leaves the picker and the palette), and skills can be **exported to and imported from a JSON
  file**, with a review step before anything imported is saved.
- **Gemini and Grok models** can be chosen on the AI Gateway route.
- A **Reasoning** setting (Auto, Off, Low, Medium, High, as each model allows) applies to every
  turn, on every route that supports it, including the ChatGPT plan where the account says so.
- The MCP settings have a **catalogue of presets** for known MCP servers (SEO data, site and CMS,
  work tracking, analytics). A preset only fills in the "Add server" form; the server stays
  untrusted, approval-gated and started by the user.
- The Content panel's readability shows **sentence length, difficult sentences and complex words**,
  scores **Spanish, French and German** text with their own published formulas, and can
  **highlight difficult sentences on the page**.

**Spec sources:**
- `docs/research/serplens-gap-analysis.md`: §2.2 (SL-019, SL-023, SL-026, SL-037), §2.5 (SL-059,
  SL-060, SL-062, SL-063, SL-066), §2.6 (SL-072–SL-083, SL-085), §3.2 backlog #2, #9, #12, §3.3
  Wave 1, §4 row "Keyword volume / CPC / difficulty", §6 Uncertainties.
- Competitor audit (data only, never copied): `serplens-surfaces-and-features.md`, entries above
  and "MCP connection catalog observed" (provider names only).
- Specs this phase extends: `specs/skills.spec.ts`, `skills-schema.ts`, `skills.feature.md`,
  `agent-data.spec.ts`, `agent-data.feature.md`, `agent-session.spec.ts`, `agent-ipc.schema.ts`,
  `agent-tools.spec.ts`, `agent-proxy.spec.ts`, `agent-protocol.schema.ts`, `agent-panel.spec.ts`,
  `agent-chatgpt.spec.ts` / `agent-chatgpt.schema.ts`, `agent-mcp.spec.ts`, `agent-page-tools.spec.ts`
  / `.feature.md`, `seo-content.spec.ts` / `.feature.md`, `seo-sidebar.spec.ts` (`HIGHLIGHT_MODES`),
  `seo-limits.spec.ts`.
- Backlog #1 (ChatGPT plan route, ungating) is **done** (`docs/plans/agent-chatgpt-plan.md`,
  `UNGATED_FEATURES` in `specs/entitlements-snapshot.spec.ts`); this plan builds on it.

**Where the gap analysis differs from the code (plan against the code):**
- *"Skills are data … The tools exist" (#2).* Mostly, but `page_data` (`summarisePageData` in
  `apps/desktop/src/main/agent/tools/audit-summary.ts`) carries no Open Graph / Twitter tags, no
  content or readability facts and no served-vs-rendered verdict, though the audit holds them
  (`audit.page.social`, and the top-level `audit.content` and `audit.javascript`,
  `packages/seo-core/src/audit.ts`). The social-tags, rewrite and rendering skills
  need them: Task 3.
- *A new built-in can hide a user's skill.* `createUserSkills` (`main/agent/user-skills.ts`) drops a
  stored skill "whose id a built-in has since taken". Growing `BUILTIN_SKILL_IDS` would silently
  hide a user skill called, say, `content-brief`. Task 4 re-keys it instead.
- *"Gemini/Grok through the Gateway" is not data-only (#9 cost S).* `MODEL_PROVIDERS` is
  `['anthropic', 'openai']`, `MODEL_CONTEXT_WINDOWS` and `AGENT_MODEL_LABELS` are total records over
  `ModelId`, and the proxy's gateway part options (`partOptions` in `agent-proxy.spec.ts`) admit only
  Anthropic and OpenAI provider data, so a Gemini tool-call turn that round-trips a thought signature
  would be refused `provider-options`. Task 7.
- *Residual gating (#1).* The code never gates skills (`createDefaultAgentEntitlements` allows all),
  but `specs/skills.feature.md` still says "running skills needs the `agent.skills` entitlement"
  (Decisions and `skill-run-refusals`). Task 4 rewords it; the port stays as a test seam, as
  `entitlements.ts` already says. `agent-mcp.spec.ts` already says MCP is never gated.
- *MCP catalogue (#9) lists Notion, Linear and similar.* frost's MCP client supports public `https:`
  with a bearer token and local commands only; there is no MCP OAuth sign-in (SL-067 note). Providers
  whose remote server needs OAuth cannot be working presets yet (Decision 9).
- *SL-083 SERP analysis.* `serp_results` answers only from the chat tab's own loaded result page for
  the same query (`ports/serp-adapter.ts`), so the skill must be run on a result page. The analysis
  says so; the skill's wording must too.

---

## Decisions

1. **Built-in skills stay read-only.** Every new built-in lists only `read`-risk tools
   (`page_audit`, `page_data`, `page_text`, `serp_results`, `search_intent`, `gsc_performance`,
   `visibility_probes`). *Why:* a built-in runs with the user's trust and one click; an acting tool
   (`run_visibility_probes`, `navigate`) would ask anyway but invites a page to steer it. *Rejected:*
   letting the crawl skill call `run_visibility_probes` (it tells the user to run probes in the
   Visibility panel when none exist).
2. **Eleven new built-ins, mapped to SL ids** (Task 4 table). *Not built:* SL-075 fact-checking
   (no web-search tool; visiting sources one approval at a time is impractical), SL-084 AI-search
   visibility (needs `run_ai_search`, Wave 5 #15), SL-085 keyword research (needs paid data: offered
   through MCP presets, Decision 9, in a typed chat), SL-077's broken-link repair and topic clusters
   (the existing `internal-link-suggestions` stays as is).
3. **Skills never offer MCP tools** (unchanged, `SkillSchema` refuses an MCP name). *Why:* MCP tool
   names carry a per-install server id (`mcp__<id>__<tool>`), so a shared skill could not name one,
   and MCP calls already ask every time in a typed chat. *Rejected:* skills that name a preset's
   tools (deferred until presets have stable ids across installs).
4. **Enable/disable lives in a new table, `agent_skill_prefs`** (migration `0200_agent_skill_prefs`),
   one row per skill the user switched (absent = enabled), for built-ins and the user's alike.
   A disabled skill stays in the library, leaves the composer picker and the palette, and
   `agent.send` refuses it `unknown-skill`. A turn already running when its skill is switched off
   finishes as it began (the skill was rendered into the user turn and its tools fixed at
   `chat.start`); only later sends are refused. *Rejected:* a key in `app_settings` (this plan adds
   no keys to another phase's tables) and a column on `agent_skills` (built-ins have no row).
5. **Search is the renderer's**, a pure filter (`filterSkills` in `specs/agent-data.spec.ts`) over
   the listed skills' names, descriptions and ids, case- and width-folded. No IPC. The composer
   picker gets the same filter and groups skills by `SKILL_CATEGORIES`.
6. **Import and export use frost's own JSON file** (`frost-skills`, version 1): an envelope holding
   `SkillSchema` skills. Main owns the files: a native save dialog for export (any skill, or all of
   the user's), a native open dialog for import; main reads at most `SKILL_FILE_MAX_BYTES`, parses,
   validates every skill with `SkillSchema`, and answers a **preview** under a single-use token:
   per skill its name, description, tools, acting-tools warning, conflict **and its full
   instructions and inputs** (bounded by `SkillSchema` itself: at most
   `SKILL_LIMITS.maxInstructionChars` each, at most `MAX_USER_SKILLS` skills, so the preview is at
   most `SKILL_FILE_MAX_BYTES`-sized). The review sheet shows each item's instructions (collapsed,
   one click to read in full, as inert text) and its Import button is enabled only once every
   selected item's instructions have been opened. Nothing is stored until the user confirms.
   Id conflicts become copies (`duplicateSkillId`), never replacements of a built-in. *Why:* an imported skill's instructions become the user's own turn,
   so the user must read what they import. *Rejected:* drag-and-drop or a pasted JSON box (the
   renderer would hold arbitrary file text), importing Claude/Codex skills (SL-131, deferred: their
   format allows tools frost does not have), Markdown preview in the editor (SL-064, not this wave).
7. **Gemini and Grok on the gateway route only.** New catalogue ids under two gateway-only
   providers (`google`, `xai`); `BYOK_ROUTE_PROVIDER` is unchanged, so `routeModelId` refuses them on
   the key routes. *Rejected:* bring-your-own Google or xAI keys (two new credential slots, routes
   and endpoint allowlists for little gain; the gateway already bills the user's own key).
8. **Reasoning effort is one setting, mapped per model, checked by main.** `REASONING_EFFORTS =
   ['auto', 'off', 'low', 'medium', 'high']`, stored in `agent-settings.json` beside the route and
   model (no migration). Each model declares the levels it supports (`MODEL_REASONING_SUPPORT`);
   the UI offers only those; a stored level the model lacks acts as `auto`. `auto` sends nothing
   (the provider's default). The runtime builds the provider options from one pure mapping in the
   spec (`reasoningWire`), and **main's proxy refuses a body whose reasoning fields differ from
   that mapping for the configured settings** (new refusal `reasoning`), as it already does for the
   model. No new route, no new endpoint (cross-plan ruling).

   **A change while a turn runs** is the user's, not a runtime fault. `model-proxy.ts` already keeps
   the settings a running turn began on (`previous`, set by the settings' `onChange` while
   `host.activeChats()` is non-empty, cleared when none runs) and tells "made for the previous
   settings" apart from a bad body (`madeForPrevious`, route/model only, structural check). An
   effort-only change gets its own step beside it (Task 8a Green gives the control flow): when the
   current check refuses `reasoning` and the body passes the composite check with the previous
   settings' effective effort on the same route and model, it is **sent** (the turn finishes on the
   level it began with; the next turn uses the new one). When the route or model changed, today's
   `model` refusal (not a fault) stands, unchanged. A body matching neither is refused `reasoning`
   and counts as a runtime fault.

   **Two layers, kept apart.** The structural allowlist stays `checkModelRequestBody(route, modelId,
   body, headers)`, unchanged in signature and behaviour: it still decides which option *shapes* and
   *values* may appear at all (`thinking` `enabled` / `disabled` / `adaptive`, budgets within the
   output cap, `reasoningEffort` / `effort` values). A new composite `checkModelRequest(route,
   modelId, effort, body, headers)` runs it first (its refusal reasons win) and then
   `checkReasoning`, which compares **only** the reasoning-bearing fields with `reasoningWire` for
   the given effort. The proxy calls the composite; tests of the structural layer keep calling the
   structural function. The effort passed is always **`effectiveEffort(settings, chatgptModels)`**,
   computed in `model-proxy.ts` for the current settings and for `previous` alike (never the raw
   stored level), so a stored `high` on a model that offers Auto only is compared as `auto`.

   **AI checks (Phase 9) are the one exception:** they are always sent and checked at `auto`, never
   the settings' effort (`checkModelRequest(route, modelId, 'auto', body, headers)` against the route
   and model the check began on), and a refused check request is never counted as an agent runtime
   fault (Phase 9 Decision 15 and Task 9 own that branch of `model-proxy.ts`).

   **Protocol:** `chat.start` carries the effort, so `AGENT_PROTOCOL_VERSION` goes 7 → 8. Phases land
   in numeric order, so Phase 8's bump is first; later phases that bump the protocol (Phases 9 and
   11) bump to current + 1 at merge.

   Per-route support:

   | Route · models | Levels offered | What the request carries |
   |---|---|---|
   | `byok-anthropic`, gateway `anthropic/*` (Claude Sonnet/Opus 5.5) | auto, low, medium, high | adaptive thinking plus effort: `thinking` + `output_config.effort` (BYOK); `providerOptions.anthropic.{thinking, effort}` (gateway). Both already in the proxy's allowlists |
   | `byok-openai`, gateway `openai/*` (GPT-5, GPT-5 mini) | auto, off, low, medium, high | `reasoning.effort` (`off` → `minimal`); gateway `providerOptions.openai.reasoningEffort` (already allowed) |
   | gateway `google/*` (Gemini) | auto, low, high (verify, Open question 3) | `providerOptions.google.thinkingConfig.thinkingLevel` (new allowlist entry) |
   | gateway `xai/*` (Grok) | auto only, unless verified otherwise | nothing |
   | `chatgpt` (the account's models) | auto, plus the levels the account's model list advertises for that model; **auto only** when it advertises none | `reasoning.effort` (already allowed by `checkChatgpt`) |

   *Rejected:* a per-model effort memory (more state, little value); a "fast mode" (SL-060; it is a
   SERP Lens server feature).
9. **MCP presets are data in a spec, and only fill the form.** `specs/agent-mcp-presets.spec.ts`
   lists presets (id, name, category, one-line description in frost's words, transport, the URL or
   the command and arguments, the environment variable names it needs, how the token is obtained,
   a vendor docs URL). Choosing one pre-fills `AgentMcp.tsx`'s add form; the user still saves, sets
   the token (write-only, keychain), and presses Start (command servers: main's native dialog, every
   time). A preset ships only when its vendor endpoint and auth were verified at implementation time
   and work with frost's client.
   - **`https:` + bearer presets** ship once verified (Open question 6).
   - **Command presets (e.g. `npx -y pkg@x.y.z`) are deferred by default.** They ship only if Open
     question 10 shows, on macOS (`sandbox-exec`), Linux (bubblewrap) and Windows (no sandbox, said
     so), that the pinned command starts under frost's command-server rules (no shell, a fresh empty
     working folder as `HOME`, `readPaths: []`, network only when the user allows it) and answers
     `tools/list`. Each pins an exact top-level version (`pkg@x.y.z`, no ranges or tags; an
     integrity-pinned form is not accepted, since `npx` cannot pin one); its **transitive
     dependencies are not pinned**, and the preset's description says so. If any OS fails, the
     catalogue ships `https:` presets only and lists command candidates as deferred.

   OAuth-only remote servers (likely Notion, Atlassian, Sentry, Cloudflare; verify) are listed in
   `MCP_DEFERRED_PRESETS` until MCP OAuth exists. *Rejected:* auto-starting or auto-saving from a preset; logos (clean-room: no
   third-party assets); fetching a catalogue from a server (no hosted frost service).
10. **Readability formulas: four languages, one shape.** `206.835 − 1.015·ASL − 84.6·ASW` (Flesch,
    `en`), Szigriszt-Pazos with the INFLESZ scale (`es`), Kandel–Moles (`fr`), Amstad (`de`): all
    `base − a·(words/sentence) − b·(syllables/word)`, so one function with per-language coefficients,
    bands and a per-language syllable heuristic (`READABILITY_FORMULAS`). These are the
    `STOP_WORD_LANGUAGES` frost already detects. Every other language gets the sentence statistics
    and long sentences, with no score. *Rejected:* LIX or other cross-language indexes (one more
    scale to explain), formulas for languages frost cannot detect.
11. **Sentence statistics are information, never a rule.** No audit rule passes or fails on them
    and the score is unchanged (as for n-grams). A sentence is **difficult** when it is longer than
    `longSentenceWords` (25) words, or, in a formula language, has at least
    `difficultSentenceMinWords` (12) words and its own formula score falls below
    `difficultSentenceScore` (30). At most `maxDifficultSentences` (20) are listed, each as an excerpt
    of at most `maxSentenceExcerptChars` (300); the total is counted uncapped.
12. **Difficult sentences are highlighted by the existing overlay**, as a new mode `sentences`
    owned by the Content panel. Main hands the painter the excerpts from the tab's own ready audit
    (as `broken` gets the link check's targets); the renderer never sends page text to paint. The
    painter finds each excerpt in the page's text nodes in the isolated SEO world and draws boxes from
    `Range.getClientRects()` in its closed shadow root: no page DOM, style or attribute change.
    The text walk has a budget (at most `SNAPSHOT_LIMITS.maxTextNodes` nodes and
    `HIGHLIGHT_BUDGET_MS`; it draws what it found in time). The painter and `planTextHighlight` are
    serialised into the isolated world with `.toString()` (as `paintHighlight` and `planHighlight`
    are in `highlightScript`), so they are self-contained: no imports, no closures, constants passed
    as arguments. A palette action "Highlight difficult sentences" is added beside the existing
    `highlight.links` / `highlight.headings`.
    *Cross-plan reuse contract:* targets are `{ text: string; kind: HighlightKind }[]`, each `kind` a
    `HIGHLIGHT_STYLES` key. Phase 11 (#6 keyphrase highlight) adds a mode and a style and passes
    targets to the same `planTextHighlight`; it does not write a second text painter.
13. **Scope cuts.** Chat history search, rename, archive and @-tabs are Phase 11 (#14). Automatic
    content-quality checks on every page (SL-019's automatic part, SL-108) are Phase 9 (#16); this
    phase ships only the on-demand skill. No "Improve with AI" button in the Content panel. Migration
    ids `0201`–`0209` stay unused.

---

## Global constraints

Everything in the Phase 0–7 constraints, `CONTRIBUTING.md` and `docs/plans/agent-chatgpt-plan.md`
still holds. In particular (`docs/design/IMPLEMENTATION-PLAN.md` §3):
- **IPC** goes only through `packages/ipc-contract` (`agent-router.ts` for agent procedures), each
  procedure behind `enforceSender`, with strict Zod inputs in `specs/agent-ipc.schema.ts`. The
  renderer never names a file path (dialogs are main's) and never sends page text to paint.
- **Page scripts** (the highlight painter) run in the isolated SEO world (`SEO_WORLD_ID`), change no
  page element, style or attribute, and draw only in their own closed shadow root, under the
  strictest page CSP. Page text that reaches the chrome (sentence excerpts) is shown as inert text.
- **Untrusted text.** Tool output stays wrapped untrusted; an imported skill's text is the user's
  responsibility but is shown in full before import; MCP servers from presets are labelled
  untrusted, ask every call, never grantable, and a command server starts only through main's dialog.
- **Secrets** stay in main: model keys, the ChatGPT tokens and MCP tokens via `safeStorage` (OS
  keychain only). A preset never holds or pre-fills a token.
- **The proxy decides.** Model requests go only to `MODEL_REQUESTS`; new provider options and part
  options are added to the allowlists by name and value, never as "any object"; reasoning fields
  must equal the mapping of the effective effort (`effectiveEffort`) of the settings, or of the settings the running turn began on (a Phase 9 AI check's request: always `auto`, Decision 8); the structural allowlist is checked first and separately.
- **No network in CI.** Gemini/Grok and reasoning tests use the AI SDK mocks and a fake `fetch`
  (`provider-capture`); presets are validated as data, never contacted; e2e uses the scripted-model
  seam (`--frost-e2e-agent-script`) and stubbed dialogs. Unpackaged-only e2e seams stay refused in
  packaged builds; this phase adds no new seam.
- **Clean-room.** Every skill text, preset description, label and band name is frost's own. The
  readability formulas are published, public formulas, cited in the spec.
- **Database:** migrations for this phase use ids **`0200`–`0209`** only (this plan uses `0200`).
  **Placement (lead ruling):** each phase's migrations live in their own new file whose list is
  spread at the **end** of `MIGRATIONS`, in phase order (8, 9, 10, 11, 12), so
  `migrations-are-forward-only` (strictly increasing ids in array order) holds. Phase 8's
  `...AGENT_SKILL_PREFS_MIGRATIONS` goes after `...CHANGE_INTEL_MIGRATIONS`, not beside
  `...AGENT_SKILLS_MIGRATIONS` (that would put `0200` before `0040`). Phase 8 is the first phase to
  add an id above `0101`, so it also moves the test-only fixture ids to `9000_` (Task 5).

## Team contract

- **New files may go in:** `packages/ai-skills/src/skills/**`, `apps/desktop/src/main/agent/**`,
  `apps/agent-runtime/src/**`, `packages/db/src/agent-skill-prefs*.ts` (+ its test; plus the
  fixture-id renames in the existing `packages/db/src/__tests__/{migrations,driver}.test.ts`, Task 5),
  `packages/seo-core/src/content/**`, `apps/desktop/src/main/seo/highlight*.ts`, renderer
  `agent-*.ts`, `components/agent/**`, `content-view.ts`, `components/seo/Content.tsx`,
  `specs/agent-*`, `specs/skills*`, `specs/seo-content*`, e2e `agent.e2e.ts`, `seo-content.e2e.ts`
  and their fixtures.
- **Hub files get one-line registrations only:** `packages/db/src/migrations.ts`
  (`...AGENT_SKILL_PREFS_MIGRATIONS`, spread last, after `...CHANGE_INTEL_MIGRATIONS`; Global
  constraints), `packages/db/src/store.ts` / `index.ts` / `agent-tables.ts`
  (the repository and table name), `apps/desktop/src/main/index.ts` (Task 2 only forwards a third
  argument on the existing `highlight.paint` line, which stays one line),
  `packages/ipc-contract/src/router.ts`
  / `services.ts` (none expected: `seo.setHighlight` already takes `HIGHLIGHT_MODES`), `App.tsx`, the
  palette registry (`renderer/palette/builtins.ts`: one `highlight(api, 'sentences', …)` line), root
  config.
- `apps/desktop/src/main/browser/controller.ts` (not a hub) supplies text targets to
  `createTabHighlights` (Task 2).
- `packages/db/src/agent-skills.ts` (not a hub) gains `rekeySkill` (Task 4; Task 5 adds the pref
  row's move), tested in the existing `packages/db/src/__tests__/agent-skills.test.ts`.
- Shared specs edited by other waves (`seo-sidebar.spec.ts` `HIGHLIGHT_MODES`, `agent-proxy.spec.ts`)
  are **append-only** in this phase.

---

## Tasks

### Task 1: Readability depth in `seo-core`
**Purpose:** sentence statistics, difficult sentences, complex words and three more formulas, pure.
- [ ] **Spec** `specs/seo-content.spec.ts`:
  - `READABILITY_LANGUAGES = ['en', 'es', 'fr', 'de']`; `READABILITY_FORMULAS: Record<ReadabilityLanguage, { id, name, base, wordsPerSentence, syllablesPerWord, bands }>` (ids `flesch`, `szigriszt-pazos`, `kandel-moles`, `amstad`; `FLESCH` and `FLESCH_BANDS` kept as the `en` entry), each with a source citation in its doc comment.
  - `SENTENCE_LIMITS = { longSentenceWords: 25, difficultSentenceMinWords: 12, difficultSentenceScore: 30, maxDifficultSentences: 20, maxSentenceExcerptChars: 300, complexWordSyllables: 3 }`; `DIFFICULT_SENTENCE_REASONS = ['long', 'complex']`.
  - `READABILITY_UNAVAILABLE_MESSAGES.language` reworded ("frost has a readability formula for English, Spanish, French and German"); the syllable heuristics' rules per language in prose.
- [ ] **Spec** `specs/seo-content.feature.md`, section Readability: scenarios below.
- [ ] **Red** (`packages/seo-core/src/__tests__/content.test.ts`):
  `syllable-heuristic-es`, `syllable-heuristic-fr`, `syllable-heuristic-de` (fixed word lists, the
  agreed counts), `readability-formulas-per-language` (a known text per language, the score and
  band), `readability-not-available` (Italian: no score, sentence stats still present),
  `sentence-stats` (average, longest, long count over a fixture), `difficult-sentences-long-and-complex`,
  `difficult-sentences-capped-and-in-page-order` (total uncapped, list ≤ 20, excerpts ≤ 300 code
  units never splitting a surrogate pair), `complex-word-share`, `sentence-stats-cjk` (segmenter
  words, no score), `sentences-are-information` (score and findings unchanged with or without them).
- [ ] **Green:** `packages/seo-core/src/content/readability.ts` (generalised formula, per-language
  `syllables`), new `content/sentences.ts` (`sentenceReport(text, lang)`), `content/report.ts`
  (`ContentReport.sentences`), `content/index.ts`, `packages/seo-core/src/index.ts` exports.
- **Shape sketch:** `Readability` `ok` gains `formula: ReadabilityFormulaId`;
  `SentenceReport = { status: 'ok'; sentences; averageWords; longestWords; longCount; complexWordShare: number | null; difficult: { total; items: { text; words; reason }[] } } | { status: 'not-available'; reason }`.
- **Acceptance:** all scenarios pass; existing Flesch tests unchanged; `purity.test.ts` still passes.
- **Risks:** syllable heuristics are approximate (say so in the spec; tests pin behaviour, not
  linguistics); a 100 000-character page must stay within the analysis worker's budget (add a
  timing assertion on the largest fixture).

### Task 2: Content panel depth and the sentence highlight (security review)
**Purpose:** show Task 1 in the Content panel and draw difficult sentences on the page. Needs Task 1.
- [ ] **Spec** `specs/seo-sidebar.spec.ts` (append): `HIGHLIGHT_MODES` += `'sentences'`;
  `HIGHLIGHT_PANELS.sentences = 'content'`; `HIGHLIGHT_STYLES` += `'long-sentence'`,
  `'complex-sentence'`; `TextHighlightTarget = { text: string; kind: HighlightKind }` (the reuse
  contract, Decision 12). `specs/seo-limits.spec.ts`: `MAX_TEXT_HIGHLIGHT_TARGETS` (= 20),
  `MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET`; the text walk reuses `SNAPSHOT_LIMITS.maxTextNodes` and
  `HIGHLIGHT_BUDGET_MS`. `specs/seo-content.feature.md`: Panel and Highlight scenarios (below), and
  "End to end" scenarios `content-readability-depth`, `content-highlight-sentences-leaves-no-residue`
  and the extended `content-page-text-is-inert` (Task 11's `seo-content.e2e.ts` tests).
  `specs/command-palette.feature.md`: the `highlight.sentences` action.
- [ ] **Red:**
  - `apps/desktop/src/main/seo/__tests__/highlight.test.ts`: `plan-text-highlight-finds-excerpts`
    (across text nodes, collapsed whitespace, first occurrence), `plan-text-highlight-unmatched-counted`,
    `text-highlight-capped`, `text-highlight-script-is-self-contained` (`highlightScript('sentences',
    …)` evaluates in a fresh context with no module scope; the stringified `planTextHighlight`
    gives the same boxes as the imported one).
  - `main/seo/__tests__/extract-dom.test.ts` (jsdom, running the **stringified** script as the
    existing link painter's tests do): `text-highlight-leaves-the-page-untouched` (no attribute,
    style or node change outside the host; closed shadow root), `text-highlight-walk-budgeted` (a
    page with more than `maxTextNodes` text nodes ends within budget and draws what it found).
  - `main/seo/__tests__/panels.test.ts`: `sentences-highlight-takes-targets-from-the-audit` (the
    controller reads the tab's ready audit; no ready audit or no difficult sentences → `false`),
    `sentences-highlight-resets-on-navigation`.
  - `renderer/__tests__/content-view.test.ts`: `readability-view-formula-and-band`,
    `sentence-stats-view`, `difficult-sentence-items` (reason chips, word counts, "and N more").
  - `renderer/palette/__tests__/builtins.test.ts`: `highlight-sentences-action` (offered only with a
    ready audit and not while already on).
- [ ] **Green:**
  - `apps/desktop/src/main/seo/highlight.ts`: `planTextHighlight` (self-contained), text targets in
    `paintHighlight` and `highlightScript(mode, targets, textTargets)`; `runHighlight` gains the
    `textTargets` argument.
  - New `apps/desktop/src/main/seo/highlight-targets.ts`: pure `sentenceHighlightTargets(audit)`
    (the ready audit's `content.sentences.difficult.items` → `TextHighlightTarget[]`, capped).
  - `apps/desktop/src/main/seo/highlights.ts`: `HighlightPainter.paint(contents, mode, textTargets)`;
    `TabHighlightsContext` gains `textTargets(tab, mode)`, which `controller.ts` supplies from its
    own audits (`sentenceHighlightTargets` for `sentences`, `[]` otherwise).
  - `apps/desktop/src/main/index.ts` (hub, the one existing line): the `highlight.paint` callback
    forwards the third argument to `runHighlight`; `broken`'s `checks.brokenFor` stays where it is.
  - Renderer `content-view.ts` helpers, `components/seo/Content.tsx` (formula name, sentence stats,
    complex words, "Difficult sentences (n)" list as inert text, a "Highlight on page" toggle like
    the Links panel's), `palette/builtins.ts` (one line), `styles.css` (classes only).
- **Acceptance:** the toggle and the palette action draw boxes on the page; the overlay is turned
  off when the user leaves the Content panel, collapses the sidebar or the page changes (existing
  `HIGHLIGHT_PANELS` rules).
- **Risks:** a page that rewrites its text after the audit leaves excerpts unmatched (counted and
  said: "3 sentences are no longer on the page"); hostile text (bidi, zero-width) must match as the
  audit read it and is passed as JSON data, never evaluated.

### Task 3: `page_data` facts the new skills read
**Purpose:** give the model the social tags, the content summary and the rendering verdict. Needs
Task 1 (`ContentReport.sentences`).
- [ ] **Spec** `specs/agent-page-tools.spec.ts`: `PAGE_AUDIT_LIMITS` += `maxSocialFields`,
  `maxDifficultSentencesForModel` (5); `specs/agent-page-tools.feature.md`: `page_data` scenario
  lists `social`, `content`, `javascript`.
- [ ] **Red** (`apps/desktop/src/main/agent/__tests__/page-tools.test.ts`):
  `page-data-social-tags` (every `PageSocial` field, cut to `maxFactChars`),
  `page-data-content-summary` (language and source, words, readability formula/score/band or the
  not-available reason, sentence stats, at most 5 difficult-sentence excerpts),
  `page-data-javascript-verdict` (the `JavascriptReport` status and verdict and the count of differing
  fields; `pending`/`unavailable` said plainly), `page-data-still-within-budget`.
- [ ] **Green:** `summarisePageData` in `apps/desktop/src/main/agent/tools/audit-summary.ts`.
- **Acceptance:** `page-data-facts` and `page-audit-trims-to-budget` still pass; output stays under
  `PAGE_AUDIT_LIMITS.budgetChars`.
- **Risks:** more untrusted page text reaches the model (it is already wrapped untrusted; caps keep
  it small).

### Task 4: The built-in SEO skill pack
**Purpose:** grow `BUILTIN_SKILL_IDS` from 3 to 14, in frost's own words, grouped in the picker.
Needs Task 3.
- [ ] **Spec** `specs/skills.spec.ts`: `BUILTIN_SKILL_IDS` (append the 11 ids below, order = picker
  order); `SKILL_CATEGORIES = ['page', 'content', 'technical', 'search']` with labels;
  `BUILTIN_SKILL_CATEGORY: Record<BuiltinSkillId, SkillCategory>` (the Category column below, the
  three existing ones included); `BUILTIN_SKILL_SOURCES` (each id → its SL ids, for the record).
  `specs/agent-session.spec.ts`: `AgentSkillView` += `category: SkillCategory | 'yours'` (here, so
  the picker can group; Task 5 adds `enabled`). `specs/skills.feature.md`: Decisions say built-ins
  use `read` tools only; **reword the `agent.skills` entitlement lines** (Decisions and
  `skill-run-refusals`) to "the entitlements port, a test seam that always allows in builds"; add
  the re-key rule below and an "End to end" scenario `agent-skill-pack-listed`.
- [ ] **Red** (`packages/ai-skills/src/__tests__/skills.test.ts`): `builtin-skills-validate`
  (extended: every built-in's tools are `read` risk and none is in `SKILL_ACTING_TOOLS`),
  `builtin-skills-have-categories`, `builtin-skills-render-golden` (each renders with fixed inputs to
  a stored golden text), `builtin-names-unique` (case- and space-folded).
  `apps/desktop/src/main/agent/__tests__/user-skills.test.ts`: `user-skill-shadowed-by-new-builtin-is-kept`
  (a stored `content-brief` loads re-keyed under `duplicateSkillId` by the atomic repository re-key
  below; a re-keyed skill whose name equals a built-in's gets `duplicateSkillName`; listed once),
  `rekey-at-full-library` (a full library of `MAX_USER_SKILLS` (50) with several ids a built-in now
  takes: every one is re-keyed, none is lost, the count stays 50 throughout; after a restart the
  same ids load and nothing is re-keyed again), `rekeyed-skill-history-label-unchanged`
  (stored chats keep the old `{ id, name }` label: it is display only, never resolved).
  `packages/db/src/__tests__/agent-skills.test.ts`: `rekey-skill-is-one-statement` (`rekeySkill`
  changes the existing row's id and JSON in place, at the cap too; never an insert, so the table is
  never one over `MAX_USER_SKILLS`; a missing old id or a taken new id writes nothing and answers
  `false`).
- [ ] **Re-key is atomic (repository):** `AgentSkillsRepository` (`packages/db/src/agent-skills.ts`)
  gains `rekeySkill(oldId, newId, skill, at)`: one `UPDATE` that sets the existing row's `id`,
  `skill` JSON and `updated_at` in a single statement, run as one `db.batch` (the pattern of
  `agent-chats.ts`; `client.ts` uses no `transaction()`). It never writes a second row, so the
  table is never temporarily one over `MAX_USER_SKILLS` (the cap `saveSkill` checks,
  `agent-skills.ts:60`), and a crash leaves either the old row or the re-keyed one, never both or
  neither. Task 5 adds the move of the skill's `agent_skill_prefs` row to the same batch. **When
  `rekeySkill` answers `false` because the new id is taken** (a row the loader's view did not
  hold), the loader tries the next `duplicateSkillId` candidate (`duplicateSkillId(id, taken)`
  called again with the refused id added to `taken`) until one succeeds or none is left; the skill
  is never dropped for a taken id.
  `main/agent/__tests__/session-skills.test.ts`: `skill-run-state-lists-skills` (extended:
  `category`). Renderer `agent-view.test.ts`: `skill-picker-grouped-by-category`.
- [ ] **Green:** `packages/ai-skills/src/skills/builtins.ts` (11 skills), `main/agent/user-skills.ts`
  (re-key on load instead of dropping, through `rekeySkill`; on a `false` answer for a taken new id,
  the next `duplicateSkillId` candidate), `packages/db/src/agent-skills.ts`
  (`rekeySkill`), `session.ts` (`category` in the view), renderer
  `agent-view.ts` / `AgentComposer.tsx` (picker grouped by category, "Your skills" last).

| Id | SL | Category | Tools | Inputs | What it must do (frost's words written at implementation) |
|---|---|---|---|---|---|
| `audit-this-page` (exists) | 070 | page | unchanged | unchanged | unchanged |
| `rewrite-title-meta` (exists) | 071 | content | unchanged | unchanged | unchanged |
| `internal-link-suggestions` (exists) | 077 | page | unchanged | unchanged | unchanged |
| `content-brief` | 072 | content | `page_data`, `page_text`, `serp_results`, `search_intent` | `targetQuery`, `userNote` | Brief for a query: intent, sections, questions to answer. Uses `serp_results` only if the tab shows that query's result page; otherwise says it worked from the page alone |
| `rewrite-page-content` | 073 | content | `page_audit`, `page_data`, `page_text` | `targetQuery`, `userNote` | A rewritten draft keeping every fact the page states; uses the difficult sentences; never claims a change was made |
| `content-quality-review` | 074, 019 | content | `page_audit`, `page_data`, `page_text` | `userNote` | Usefulness, evidence, freshness, intent fit; a refresh list |
| `match-page-to-queries` | 076 | search | `gsc_performance`, `page_data`, `page_text` | `userNote` | This page's queries vs. its content; queries it should or should not serve. One page only, said plainly |
| `check-structured-data` | 078 | technical | `page_audit`, `page_data` | — | Schema findings, missing recommended properties, JSON-LD suggestions as text |
| `check-hreflang` | 079 | technical | `page_audit`, `page_data` | — | Return links, x-default, language/region codes, canonical conflicts |
| `diagnose-rendering` | 080, 037 | technical | `page_audit`, `page_data`, `visibility_probes` | — | Served vs. rendered differences and what they mean for crawlers |
| `check-crawl-and-indexing` | 081 | technical | `page_audit`, `page_data`, `visibility_probes` | — | robots, noindex, canonical, status, crawler access; asks the user to run probes when none exist |
| `diagnose-search-performance` | 082 | search | `gsc_performance`, `page_data`, `page_audit` | `userNote` | Clicks, impressions, CTR, position; likely causes; says when Search Console is not connected |
| `analyse-serp` | 083 | search | `serp_results`, `search_intent`, `page_data` | `targetQuery` | Composition, who ranks, intent; must be run on that query's result page |
| `write-social-tags` | 026 | content | `page_data`, `page_text`, `page_audit` | `userNote` | Open Graph and Twitter values as suggestions, with lengths |

- **Acceptance:** the composer (grouped) and the palette list 14 built-ins; `skill-run-narrows-the-tools`
  holds for each; `SKILL_LIMITS.maxSkills` (100) ≥ 14 + `MAX_USER_SKILLS` (50).
- **Risks:** prompt quality is untestable offline (golden renders guard drift, not quality; the lead
  should try each skill once with a real model before release, Open question 8).

### Task 5: Skills library — enable/disable and search
**Purpose:** SL-063's search and switches. Needs Task 4.
- [ ] **Spec** `specs/agent-data.spec.ts`: `AGENT_SKILL_PREF_TABLES = ['agent_skill_prefs']`,
  `filterSkills(skills, query)` (pure; NFKC + case fold over name, description, id),
  `SKILL_LIBRARY_WORDS` (search placeholder, "On"/"Off", "No skills match"). `specs/agent-session.spec.ts`:
  `AgentSkillView` += `enabled: boolean`. `specs/agent-ipc.schema.ts`:
  `AgentSetSkillEnabledInputSchema = { id, enabled }`. `specs/agent-data.feature.md`: Skills library
  section, including the running-turn rule (Decision 4) and an "End to end" scenario
  `agent-skill-library-search-and-disable`.
- [ ] **Red:**
  - `packages/db/src/__tests__/agent-skill-prefs.test.ts`: `agent-skill-prefs-migrate` (`0200`
    creates the table), `agent-skill-prefs-round-trip`, `agent-skill-prefs-capped-and-tamper-safe`.
  - `packages/db/src/__tests__/migrations.test.ts`: `migrations-are-forward-only` passes with
    `...AGENT_SKILL_PREFS_MIGRATIONS` spread last. **Fixture-id step (lead ruling; Phase 8 does it
    once for every later phase):** `0200` sorts after the test-only ids, and `recordedIds` reads
    `ORDER BY id`, so the expectations at `migrations.test.ts:106-108` and `driver.test.ts:298-300`
    would fail. Rename the test-only ids: `0100_test_extra` → `9000_test_extra`
    (`migrations.test.ts:106-108`, `driver.test.ts:298-300`), `0100_broken` → `9000_broken`
    (`migrations.test.ts:133-138`), `0101_broken` → `9001_broken` (`driver.test.ts:303-307`). All stay
    below the existing `9999_from_the_future`. No assertion is weakened.
  - `main/agent/__tests__/user-skills.test.ts`: `skill-disable-hides-from-picker-not-library`,
    `skill-delete-removes-its-pref`, `skill-prefs-unknown-ids-pruned-on-load`,
    `rekeyed-disabled-skill-stays-disabled` (a disabled user skill whose id a built-in takes is
    re-keyed with its pref row in the same batch; after a restart it is still off, under its new id;
    **ordering:** on load the re-keying finishes before the prefs are read or pruned, so the old
    id's pref row is moved, never pruned as unknown first; **taken id:** `rekeySkill` answers
    `false` for the first `duplicateSkillId` candidate (that id is taken), the loader tries the next
    candidate, and the skill ends up under it, still off).
  - `main/agent/__tests__/session-skills.test.ts`: `skill-run-refuses-a-disabled-skill`
    (`unknown-skill`, nothing changes), `skill-disabled-mid-turn-finishes-the-turn` (the running turn
    completes with its tools; the next send is refused).
  - `packages/ipc-contract/src/__tests__/agent-router.test.ts`: `agent-set-skill-enabled-bounds`.
  - `renderer/__tests__/agent-data-view.test.ts`: `filter-skills`; `agent-data-components.test.ts`:
    `skills-library-search-and-switches`; `agent-palette.test.ts`: `skill-palette-lists-enabled-only`.
- [ ] **Green:** migration `packages/db/src/agent-skill-prefs-migrations.ts`
  (`0200_agent_skill_prefs`: `id TEXT PRIMARY KEY NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), updated_at INTEGER NOT NULL`),
  `agent-skill-prefs-schema.ts`, `agent-skill-prefs.ts`; registrations in `migrations.ts`
  (`...AGENT_SKILL_PREFS_MIGRATIONS` spread **after** `...CHANGE_INTEL_MIGRATIONS`, the last spread
  today), the fixture-id renames in `migrations.test.ts` and `driver.test.ts` (Red), `store.ts`,
  `agent-tables.ts`, `index.ts`; `rekeySkill` (Task 4) also re-keys the skill's `agent_skill_prefs`
  row, if any, in the same `db.batch` as the `agent_skills` update;
  `main/agent/user-skills.ts` (or new `skill-prefs.ts`; on load, re-keying finishes before the
  prefs are read or pruned),
  `session.ts`, `service.ts`; `agent-router.ts` (`setSkillEnabled`, `enforceSender`);
  `AgentSkills.tsx` (search box, switch per row), `AgentComposer.tsx` and `agent-palette.ts`
  (enabled only, picker search).
- **Acceptance:** a disabled built-in stays in the library with its switch off, is absent from the
  picker and the palette, and comes back when switched on; restart keeps it.
- **Risks:** pref rows are capped at `SKILL_LIMITS.maxSkills`; rows for ids no skill has are pruned
  on load, after re-keying has finished (tested above).

### Task 6: Skill import and export (security review)
**Purpose:** move skills between installs as files, with a review before import. Needs Task 5.
- [ ] **Spec** `specs/skills-schema.ts`: `SkillFileSchema = { format: 'frost-skills', version: 1, exportedAt, skills: SkillSchema[] (1..MAX_USER_SKILLS) }`.
  `specs/agent-data.spec.ts`: `SKILL_FILE_FORMAT`, `SKILL_FILE_VERSION`, `SKILL_FILE_MAX_BYTES`
  (2 MiB), `skillExportFileName`, `SKILL_IMPORT_TOKEN_TTL_MS` (10 min), `SKILL_IMPORT_CONFLICTS =
  ['none', 'builtin-id', 'exists', 'builtin-name']`, `SKILL_IMPORT_RESULTS`, `SKILL_EXPORT_RESULTS`
  and messages, `AgentSkillImportPreview` (token, items: index, id, name, description, tools,
  `actingTools`, conflict, `valid`, error, **`instructions`, `inputs`** for valid items; invalid
  items carry no instructions, only frost's error). `specs/agent-ipc.schema.ts`:
  `exportSkills({ ids | 'all-mine' })`, `previewSkillImport()` (no input), `importSkills({ token,
  indices })`, `cancelSkillImport({ token })`. `AgentDialogs` gains `chooseSkillExportPath`,
  `chooseSkillImportFile`. `specs/agent-data.feature.md`: Import/export section and an "End to end"
  scenario `agent-skill-export-import`.
- [ ] **Red** (`main/agent/__tests__/skill-files.test.ts`, new): `skill-export-writes-validated-envelope`
  (chosen path only; written atomically, temp file then rename as `settings.ts` does, with the chat
  export's mode `0600`), `skill-import-reads-bounded-utf8` (over-size, invalid UTF-8, not JSON, wrong
  `format`/`version` → plain refusals), `skill-import-validates-each-skill` (an invalid skill is listed
  `valid: false` with frost's message, never stored), `skill-import-preview-carries-full-instructions`
  (each valid item's instructions and inputs equal the file's, within `maxInstructionChars`; the
  whole preview within `SKILL_FILE_MAX_BYTES`), `skill-import-conflicts-become-copies` (built-in id,
  existing id, built-in name → `duplicateSkillId` / `duplicateSkillName`),
  `skill-import-token-single-use-and-expires`, `skill-import-respects-max-user-skills`,
  `skill-import-hostile-text-stays-data` (a name with bidi controls or `}}` is refused by
  `SkillSchema`; instructions are previewed, never run, before confirmation).
  Router: `agent-skill-file-procedures-enforce-sender-and-bounds` (the preview's answer is rebuilt
  field by field and re-bounded, as `checkedSaveSkillResult` does). Renderer
  (`agent-data-components.test.ts`): `skill-import-review-sheet` (each item's tools, the acting-tools
  warning and its instructions as inert text; invalid items not selectable; **Import stays disabled
  until every selected item's instructions have been opened**).
- [ ] **Green:** `main/agent/skill-files.ts` (new), `dialogs.ts` (open and save dialogs, JSON filter),
  `service.ts`, `session.ts`, `agent-router.ts`, `AgentSkills.tsx` (Export, Export all, Import…,
  the review sheet).
- **Acceptance:** export then import on a fresh profile yields the same skills (as copies where ids
  clash); a cancelled dialog changes nothing; the user cannot import a skill without its
  instructions having been on screen.
- **Risks:** an imported skill is an instruction the user will send as their own turn: the review
  sheet is the control (full instructions, `SKILL_WARNINGS.actingTools`). An export is written
  owner-only like chat exports; the user shares it by copying the file.

### Task 7: Gemini and Grok on the gateway (security review)
**Purpose:** SL-059's wider model choice without a new route.
- [ ] **Spec** `specs/agent-tools.spec.ts`: `MODEL_PROVIDERS` += `'google'`, `'xai'`;
  `GATEWAY_ONLY_PROVIDERS = ['google', 'xai']`; `ALLOWED_MODEL_IDS` += two Gemini and two Grok ids
  (working ids `google/gemini-3-pro`, `google/gemini-3-flash`, `xai/grok-4`, `xai/grok-4-fast`;
  replaced with the gateway's current ids at Task start, Open question 2). **Tests refer to these
  ids only through the spec constant** (e.g. `ALLOWED_MODEL_IDS.filter(byProvider('google'))`), never
  as literals, so the replacement touches the spec alone. `specs/agent-panel.spec.ts`:
  `AGENT_MODEL_LABELS` entries. `specs/agent-session.spec.ts`: `MODEL_CONTEXT_WINDOWS` entries (the
  gateway's published figure, else `null`). `specs/agent-proxy.spec.ts` (append): `partOptions` +=
  `google: { thoughtSignature: string }` (and `vertex` only if the gateway uses that key, Open
  question 3); `GATEWAY_PROVIDER_OPTIONS` += `google: { thinkingConfig }` with an exact shape check
  (`thinkingLevel` values, `includeThoughts` boolean) and `xai: {}` (nothing until verified).
  Scenarios in `specs/agent-host.feature.md` (where the proxy scenarios live) and
  `specs/agent-protocol.feature.md` (`ALLOWED_MODEL_IDS`).
- [ ] **Red:** `packages/ai-skills/src/__tests__/agent-tools.test.ts`:
  `route-model-id-gateway-only-providers` (Gemini/Grok refused on `byok-anthropic`/`byok-openai`,
  passed through on `gateway`). `apps/desktop/src/main/agent/__tests__/proxy-rules.test.ts`:
  `proxy-gemini-thought-signature-accepted`, `proxy-google-options-allowlisted` (unknown keys,
  `thinkingBudget` over the cap, `cachedContent`, safety settings, search grounding → `provider-options`),
  `proxy-xai-options-refused`. `apps/agent-runtime/src/__tests__/provider.test.ts`:
  `gateway-gemini-tool-turn-round-trips` (a fake gateway stream with a tool call carrying a thought
  signature; the second request's body passes `checkModelRequestBody`). Renderer
  `agent-view.test.ts`: `model-options-grouped-by-provider`.
- [ ] **Green:** the spec values; `apps/agent-runtime/src/provider.ts` needs no change (the gateway
  provider takes any allowed id), but confirm with the capture test; `AgentSettings.tsx` model
  select grouped by provider.
- **Acceptance:** choosing a Gemini or Grok model on the gateway route runs a scripted turn; the
  same id on a key route is refused before any request.
- **Risks:** Gemini rejects a function-call turn without its thought signature: the round-trip test
  is the guard; providers may attach other part metadata (allow only what a captured stream shows).
  Whether these models accept the runtime's tool choice is Open question 11.

### Task 8a: Reasoning effort — spec, settings and the proxy's check (security review)
**Purpose:** the security-critical half of SL-060: what may be sent, decided by main. Needs Task 7.
- [ ] **Spec** new `specs/agent-reasoning.spec.ts` (plain values; it imports `ChatgptModelView`
  and `AgentModelSettings` with `import type` only, while `agent-chatgpt.spec.ts` and
  `agent-proxy.spec.ts` import its values, so no runtime import cycle forms): `REASONING_EFFORTS`,
  `ReasoningEffort`, `MODEL_REASONING_SUPPORT: Record<ModelId, readonly ReasoningEffort[]>` (Decision
  8 table), `reasoningLevels(modelId, chatgptModels)`, `effectiveEffort(settings, chatgptModels)`
  (unsupported → `auto`), `reasoningWire(route, modelId, effort)` (the provider-options fragment the
  runtime sends; `{}` for `auto`), `reasoningFieldsOf(route, body)` and
  `checkReasoning(route, modelId, effort, body)` (the body's reasoning-bearing fields equal the
  wire's: Anthropic `thinking`/`output_config`, OpenAI and ChatGPT `reasoning.effort`, gateway
  `providerOptions.{anthropic.thinking, anthropic.effort, openai.reasoningEffort, google.thinkingConfig}`;
  `reasoning.summary` and `include` are not compared). `specs/agent-proxy.spec.ts` (append):
  `PROXY_REFUSALS` += `'reasoning'`; `AgentModelSettings` += `reasoningEffort` (optional on read,
  default `auto`; `isValidModelSettings` accepts any `REASONING_EFFORTS` value);
  `checkModelRequestBody` **unchanged** (the structural layer) and a new
  `checkModelRequest(route, modelId, effort, body, headers)` (structural first, then
  `checkReasoning`; Decision 8). `specs/agent-chatgpt.schema.ts` / `agent-chatgpt.spec.ts` (moved
  here from 8b so 8a's functions have their input type): `ChatgptModelEntrySchema` reads an optional
  list of supported efforts (field name per Open question 1). **Bounded:** only the levels
  `CHATGPT_ADVERTISED_EFFORTS = ['off', 'low', 'medium', 'high']` are kept (`auto` is always implied
  and never stored; unknown values dropped), duplicates removed, in `REASONING_EFFORTS` order, so at
  most 4; an empty result is stored as no `efforts` key. `ChatgptModelView` += optional
  `efforts: readonly ReasoningEffort[]`; `isChatgptModelView` accepts 2 keys, or 3 keys only when
  `efforts` is a non-empty array of distinct `CHATGPT_ADVERTISED_EFFORTS` values in that order (a
  duplicate, an unknown value, `auto` or more than 4 items rejects the entry); a file from the
  previous build (2 keys) still reads. `CHATGPT_EFFORTS_ENTRY_MAX_BYTES = 64`: the worst case
  `,"efforts":["off","low","medium","high"]` is 40 bytes, so 64 leaves room. `specs/agent-host.feature.md`: Settings
  and proxy scenarios below, including the mid-turn rule (Decision 8).
- [ ] **Red:**
  - `main/agent/__tests__/settings.test.ts`: `settings-reasoning-default-auto-and-persisted`,
    `settings-old-file-without-reasoning-reads-auto`, `settings-tampered-reasoning-reads-auto`,
    `settings-reasoning-change-notifies` (`onChange` fires with the previous settings),
    `settings-chatgpt-models-keep-efforts` (a persisted list with `efforts` round-trips; a file of
    the previous build, `{ id, label }` only, still reads),
    `settings-largest-model-list-with-efforts-fits` (64 entries, each with the longest slug, a label
    of `maxDisplayNameChars` 3-byte characters and all four levels, is written and read back: the
    write is under `MAX_SETTINGS_FILE_BYTES`).
  - `main/agent/__tests__/chatgpt-spec.test.ts`: `chatgpt-model-entry-efforts-parsed` (known values
    kept in `REASONING_EFFORTS` order, duplicates and `auto` and unknown values dropped, at most 4,
    empty or absent → no key; `isChatgptModelView` accepts 2 keys and a well-formed 3-key entry and
    rejects `efforts` with a duplicate, an unknown value, `auto`, 5 items or an empty array;
    `JSON.stringify` of the worst case is ≤ `CHATGPT_EFFORTS_ENTRY_MAX_BYTES`).
  - `main/agent/__tests__/proxy-rules.test.ts`: `proxy-reasoning-must-match-settings` (per route: an
    effort the settings don't hold, or one sent under `auto`, → `reasoning`),
    `proxy-reasoning-off-maps-to-minimal-on-openai`, `proxy-anthropic-adaptive-thinking-within-cap`
    (all through `checkModelRequest`).
  - **Existing tests adapted, not deleted:** `proxy-gateway-option-values` (`proxy-rules.test.ts`,
    the `openai.reasoningEffort: 'low'`, `anthropic.effort: 'medium'` and `thinking`
    `enabled`/`disabled`/`adaptive` cases) keeps every assertion against the structural
    `checkModelRequestBody` (its `reason` helper is unchanged), so the allowlist's shapes and the
    `output-cap` budget rule stay tested and reachable. One block is added to it: the same
    `ok` bodies through `checkModelRequest` are refused `reasoning` under every effort whose
    `reasoningWire` differs (e.g. `thinking.enabled` under any effort, `reasoningEffort: 'low'` under
    `auto`), and accepted under the effort that maps to them, where one exists (no effort's wire
    produces, for example, `openai.reasoningEffort` on an `anthropic/*` model or `anthropic.effort`
    without `thinking`; those are refused under every effort). `proxy-body-model-mismatch`,
    `proxy-openai-store-required` and the other structural tests are untouched. Callers that check a
    whole request (`model-proxy.ts`, `model-proxy-chatgpt.test.ts`, the runtime's
    `provider.test.ts` capture assertions) move to `checkModelRequest` with an explicit effort
    (`auto` for today's bodies); `chatgpt-spec.test.ts`'s structural checks stay as they are.
  - `main/agent/__tests__/model-proxy.test.ts`: `proxy-reasoning-change-mid-turn-is-not-the-runtimes-fault`
    (a turn runs; the user switches High → Low; a body with High is sent, no fault counted, and the
    next turn's body must carry Low), `proxy-reasoning-matching-neither-refused` (`reasoning`,
    counted), `proxy-model-change-mid-turn-unchanged` (today's `model` refusal still holds when the
    model changed too), `proxy-unsupported-stored-effort-acts-as-auto` (stored `high`, model offers
    Auto only, or a ChatGPT model with no advertised levels: a body with no reasoning field is sent,
    one with `high` is refused `reasoning`; the same for `previous` mid-turn).
- [ ] **Green:** `specs/agent-reasoning.spec.ts`, the `agent-proxy` and `agent-chatgpt` spec
  changes above.
  - `apps/desktop/src/main/agent/settings.ts`: the effort field (the `set` merge and `current` keep
    it; `onChange` also fires when only the effort changed); `cleanModels` keeps `efforts` through
    `isChatgptModelView`; `MAX_ENTRY_BYTES` (here, beside `MAX_SETTINGS_FILE_BYTES` at
    `settings.ts:62`) adds `CHATGPT_EFFORTS_ENTRY_MAX_BYTES`, and the file's fixed part adds room for
    the `"reasoningEffort"` key and its longest value.
  - `apps/desktop/src/main/agent/model-proxy.ts`, **control flow** (replacing today's
    `checkModelRequestBody` call at `:341`):
    1. `effort = effectiveEffort(settings, deps.settings.chatgptModels())`; when `previous` is set,
       `previousEffort = effectiveEffort(previous, deps.settings.chatgptModels())`. Never the raw
       stored level.
    2. `check = checkModelRequest(route, modelId, effort, body, headers)`.
    3. If `check` fails with **`reasoning`**: if `previous` is set **and** `previous.route === route`
       **and** `previous.modelId === modelId` **and** `previousEffort !== effort` **and**
       `prior = checkModelRequest(route, modelId, previousEffort, body, headers)` passes, the request
       **continues with `prior.body`** (not the failed check's) through the normal path below (the
       credential slot, `handleChatgpt` or the fetch), uncounted. Otherwise it is refused
       `reasoning` and **counted** (`strike`).
    4. If `check` fails with any other reason: today's code, unchanged — `madeForPrevious(body)` →
       refuse `model` uncounted, else refuse `check.reason` (counted as today).
    5. If `check` passes: today's "fits both" branch, unchanged (`madeForPrevious` → refuse `model`
       uncounted), then the normal path with `check.body`.
    `madeForPrevious` keeps today's guard (`previous.route !== route || previous.modelId !==
    modelId`) and keeps calling the **structural** `checkModelRequestBody(previous.route,
    previous.modelId, …)`, not the composite. *Why:* it answers only "was this body shaped for the
    route or model the turn began on?", and such a body is refused `model` whatever effort it carries,
    so its effort is irrelevant; adding the effort there would widen the "fits both" refusal to
    effort-only changes, which step 3 must send instead. Effort-only changes are handled in step 3
    alone. (Phase 9 later adds a separate branch before step 1 for a live AI check's request:
    checked at `auto`, never counted; Decision 8. Steps 1–5 stay the turn's path.)
- **Acceptance:** main refuses any reasoning field that is not the mapping of the settings (or of the
  settings the running turn began on); a restart keeps the level.
- **Risks:** a runtime that sends a different effort is refused, never trusted; reasoning tokens vs
  `MAX_OUTPUT_TOKENS` (Open question 5).

### Task 8b: Reasoning effort — protocol, runtime, session, ChatGPT levels and IPC
**Purpose:** carry the effort from the settings to the request. Needs Task 8a.
- [ ] **Spec** `specs/agent-protocol.schema.ts`: `AGENT_PROTOCOL_VERSION = 8` (first bump after 7;
  Decision 8), `chat.start.reasoningEffort: z.enum(REASONING_EFFORTS)`. `specs/agent-ipc.schema.ts`:
  `AgentSetReasoningEffortInputSchema`. `specs/agent-session.spec.ts`: `AgentSetupView.reasoning =
  { effort, levels }`. (The ChatGPT entry/view schema change is in 8a; 8b fills it from the
  account's list.) `specs/agent-protocol.feature.md`, `agent-chatgpt.feature.md`: scenarios below.
- [ ] **Red:**
  - `packages/ai-skills/src/__tests__/agent-protocol.test.ts`: `chat-start-reasoning-effort`.
  - `apps/agent-runtime/src/__tests__/chat.test.ts`: `chat-call-options-carry-reasoning` (each
    route/provider; `auto` sends nothing; the ChatGPT route still sends no output cap).
  - `apps/agent-runtime/src/__tests__/provider.test.ts` (capture): `reasoning-body-per-route` (each
    captured body passes `checkModelRequest` with the same effort).
  - `main/agent/__tests__/session.test.ts`: `session-sends-effective-effort` (a level the model lacks
    → `auto`; a ChatGPT model with no advertised levels → `auto`).
  - `main/agent/chatgpt/__tests__/` (new file `models.test.ts`): `chatgpt-models-keep-advertised-efforts`
    (the listing maps each entry's advertised efforts into the 8a view and persists them).
  - `packages/ipc-contract/src/__tests__/agent-router.test.ts`: `agent-set-reasoning-effort-bounds`.
  - Fixtures: `chat.start` builders in `main/agent/__tests__/session-fakes.ts` and the runtime's
    `harness.ts` gain the field.
- [ ] **Green:** `apps/agent-runtime/src/chat.ts` (`chatCallOptions(route, modelId, effort)` merges
  `reasoningWire`), `main/agent/session.ts` (`chat.start.reasoningEffort` from `effectiveEffort`,
  `AgentSetupView.reasoning`), `chatgpt/` model listing, `agent-router.ts` (`setReasoningEffort`,
  `enforceSender`), `service.ts`.
- **Acceptance:** for each route the captured request carries exactly the mapped fields and main
  sends it; the ChatGPT route offers only advertised levels.
- **Risks:** the protocol bump touches every `chat.start` fixture; keep it in this task so 8a's
  security review stays small.

### Task 9: Model and reasoning settings UI
**Purpose:** let the user pick Gemini/Grok and a reasoning level, and say what each costs. Needs
Task 8b.
- [ ] **Spec** `specs/agent-panel.spec.ts`: `AGENT_REASONING_LABELS` (Auto = "Auto (the model's
  default)", Off, Low, Medium, High; on OpenAI models Off reads "Minimal"),
  `AGENT_REASONING_HINT` (one line: higher levels are slower and use more of the key's or plan's
  allowance), `AGENT_REASONING_UNAVAILABLE` (why a model offers Auto only).
  `specs/agent-panel.feature.md` / `agent-chatgpt.feature.md`: scenarios below and an "End to end"
  scenario `agent-model-and-reasoning-settings`.
- [ ] **Red** (`renderer/__tests__/agent-view.test.ts`, `agent-components.test.ts`,
  `agent-chatgpt-components.test.ts`): `reasoning-options-follow-the-model`,
  `reasoning-select-sends-set-reasoning-effort`, `reasoning-auto-only-explained`,
  `chatgpt-reasoning-from-account-list`.
- [ ] **Green:** `components/agent/AgentSettings.tsx` (Reasoning select under Model, hint, disabled
  with the reason when only Auto), `agent-view.ts` helpers, `agent-actions.ts`.
- **Acceptance:** switching the model updates the offered levels at once; the stored level persists
  and shows "Auto" where it does not apply.
- **Risks:** none beyond Task 8a's.

### Task 10: MCP presets catalogue (security review)
**Purpose:** SL-066 / SL-085: known MCP servers one click from a filled form, on the user's own
accounts.
- [ ] **Verify first** (record the date and the vendor doc each row came from in the spec comment):
  for each candidate, its transport, URL or package and exact version, auth (bearer token vs. OAuth),
  and terms for third-party clients (Open question 6); for command candidates, Open question 10 and
  the ship/defer rule of Decision 9. Candidates (provider names from the audit and §4):
  - SEO data: Ahrefs, Semrush, SE Ranking, SISTRIX, DataForSEO.
  - AI-search visibility: Profound, Peec AI, Otterly (only if a public MCP server exists).
  - Site and CMS: WordPress (self-hosted, local command), Webflow, Sanity, Storyblok, Wix.
  - Work tracking: GitHub, GitLab, Linear, ClickUp, Trello, Shortcut, monday.com.
  - Analytics: PostHog, Cloudflare, Sentry. Reporting: Airtable, Coda.
- [ ] **Spec** new `specs/agent-mcp-presets.spec.ts` (plain values): `MCP_PRESET_CATEGORIES`
  (`seo-data`, `ai-visibility`, `site`, `work`, `analytics`, `reporting`, with labels),
  `MCP_PRESETS: readonly McpPreset[]` (`id`, `name`, `category`, `description`, `transport`, `url` |
  `command` + `args` (exact top-level version), `envNames`, `auth: 'bearer' | 'env' | 'none'`,
  `tokenHint`, `docsUrl`), `MCP_DEFERRED_PRESETS` (name and reason: OAuth only, sandbox failure,
  terms), `filterPresets(query, category)`, `presetDraft(preset)` (the `AgentSaveMcpServerInput`
  the form starts from, no token, no env values, `allowNetwork` true only when the server needs it).
  New `specs/agent-mcp-presets.feature.md`, with an "End to end" scenario `agent-mcp-preset-fills-form`.
- [ ] **Red** (new `apps/desktop/src/main/agent/__tests__/mcp-presets.test.ts`): `mcp-presets-valid`
  (every URL passes `parseMcpServerUrl`; every command `isMcpCommand`, every arg `isMcpArg`, every
  env name `isMcpEnvName` and not reserved; every `docsUrl` passes main's `resolveExternalOpen`
  (`main/security/policy.ts`) with a gesture), `mcp-presets-pin-versions` (a command preset's package
  argument is `name@x.y.z`, exact semver; ranges, tags such as `@latest`, and no version are refused;
  no integrity form exists to accept), `mcp-presets-hold-no-secret`,
  `mcp-command-presets-say-dependencies-unpinned` (each command preset's description says so),
  `mcp-preset-draft-saves-through-the-normal-path` (`agent.saveMcpServer` with the draft, then the
  token, then Start's dialog, unchanged), `mcp-presets-unique-ids-and-names`.
  Renderer `agent-mcp.test.ts`: `mcp-catalogue-search-and-categories`, `mcp-preset-fills-the-form`
  (nothing saved until Save; the untrusted label shown).
- [ ] **Green:** `components/agent/AgentMcp.tsx` (an "Add from catalogue" sheet: search, category
  chips, preset rows with a docs link that opens in the system browser through the existing
  window-open path), renderer `agent-mcp-presets.ts` (new: the catalogue's view helpers).
- **Acceptance:** a preset fills the form; saving, the token and Start behave exactly as for a server
  typed by hand (`agent-mcp.feature.md` unchanged).
- **Risks:** vendor endpoints and packages change (pinned versions and the verification date make
  drift visible); a command preset runs third-party code whose dependencies are not pinned (the
  start dialog, the sandbox sentence, the pinned top-level version and the default-defer rule are
  the controls).

### Task 11: End-to-end
**Purpose:** the user-visible outcomes in the real app, no third-party network. Each test cites the
"End to end" scenario its task added to a `.feature.md` (Tasks 2, 4, 5, 6, 9, 10).
- [ ] `apps/desktop/e2e/agent.e2e.ts` (scripted model seam, dialogs stubbed with `app.evaluate` as in
  `agent-chat-export-and-restore`):
  - `agent-skill-pack-listed` — the picker shows 14 built-ins in their groups; a new built-in's run
    offers only its tools (scripted `navigate` is refused as in `agent-skill-narrows-tools`).
  - `agent-skill-library-search-and-disable` — search narrows the list; switching a skill off hides
    it from the picker and the palette, and a restart keeps it off.
  - `agent-skill-export-import` — export all to a temp file (stubbed save dialog), delete, import it
    (stubbed open dialog); the review sheet shows tools, the warning and the instructions, Import is
    enabled only after they were opened; import restores the skills.
  - `agent-model-and-reasoning-settings` — choose a Gemini model on the gateway route and High;
    reopen the panel: both kept; on a Grok model the select shows Auto only.
  - `agent-mcp-preset-fills-form` — choose an HTTP preset: the form is filled, the server is saved
    stopped and untrusted. Nothing is contacted: the test records every request on main's
    `agent-mcp` session (`AGENT_MCP_PARTITION`) through `session.webRequest.onBeforeRequest`, set
    with `app.evaluate` before the preset is chosen, and asserts the log is empty.
- [ ] `apps/desktop/e2e/seo-content.e2e.ts`, new inline fixture routes on its local `node:http`
  server (a Spanish article; a long English article served with a strict CSP):
  - `content-readability-depth` — Spanish route: the Szigriszt-Pazos score and band, sentence stats
    and the difficult-sentence list.
  - `content-highlight-sentences-leaves-no-residue` — toggle on: boxes drawn; leaving the panel and
    navigating remove them; the page's DOM is as before (the same checks as `seo-panels.e2e.ts`'s
    `highlight-links-leaves-no-residue`).
  - `content-page-text-is-inert` (extended) — a sentence holding markup shows as text.
- **Acceptance:** `pnpm test:e2e` green on macOS, Linux and Windows CI; the security gates
  (Electronegativity, Semgrep `ipc-sender-guard`, `openExternal`-deny) unchanged and green.

---

## Open questions

| # | Question | How to resolve | Blocks |
|---|---|---|---|
| 1 | Does the ChatGPT plan's `GET /v1/models` entry advertise supported reasoning efforts (and under what field: Codex's `supported_reasoning_levels` / `default_reasoning_level`, or another)? | Live check with a Plus and a Pro account; read the SIWC "models and inference" page again. Until known, the `chatgpt` route offers Auto only | Only the `chatgpt` row's levels; Tasks 8b and 9 proceed with Auto-only as the fallback |
| 2 | The gateway's current Gemini and Grok ids and context windows | `GET https://ai-gateway.vercel.sh/v1/models` at Task 7 start; replace the working ids in the spec constant | Task 7 |
| 3 | Gemini via the gateway: the provider-options key (`google` or `vertex`), the part metadata a tool turn carries (thought signatures), `thinkingLevel` values; whether Grok models accept any reasoning option | Gateway and AI SDK provider docs for the pinned `@ai-sdk/gateway` version; capture one real stream by hand (not in CI) and turn it into a fixture | Task 7, Task 8a |
| 4 | Anthropic effort with adaptive thinking on Claude Sonnet/Opus 5.5 with the installed `@ai-sdk/anthropic`: field names, any beta header (`ANTHROPIC_BETA_ALLOWLIST`) | Provider docs and the package's request builder; a capture test | Task 8a |
| 5 | Does `high` reasoning fit under `MAX_OUTPUT_TOKENS` (16 384) on OpenAI models, where reasoning tokens count toward the cap? | Measure a few real turns; if answers are cut, raise the cap per effort in `agent-proxy.spec.ts` (a separate reviewed change) | Release gate for Task 8a/8b |
| 6 | For each MCP preset candidate: endpoint, transport, auth, package and version, and whether its terms allow a third-party desktop client | Vendor docs, recorded in the spec comment with the date; drop any that need OAuth | Task 10 |
| 7 | Readability formula coefficients and bands from primary sources (Szigriszt-Pazos 1993 and the INFLESZ scale, Barrio-Cantalejo 2008; Kandel & Moles 1958; Amstad 1978) | Cite the sources in `seo-content.spec.ts`; if a coefficient cannot be confirmed, ship that language with sentence stats only | Task 1 |
| 8 | Skill quality: do the 11 new skills give useful answers on real pages and models? | The lead runs each once on BYOK and on the ChatGPT plan before release and edits wording (version bump) | Release, not merge |
| 9 | Should the skill file later read Claude/Codex skill formats (SL-131)? | Decide in a later wave; the `frost-skills` envelope's `format`/`version` leave room | — |
| 10 | Does a pinned command preset (`npx -y pkg@x.y.z`) start under frost's MCP command rules on each OS: no shell; a fresh empty working folder as `HOME` (so npm's cache lands there and is downloaded again at every start); `readPaths: []` (the macOS profile and bubblewrap hide every home, `.config`, `Library`, `userData`); network only when allowed? Does `npx` itself resolve on the minimal `PATH`? Its transitive dependencies are unpinned: acceptable for a preset? | On a macOS, a Linux (bubblewrap) and a Windows machine, add each candidate by hand with network allowed and press Start; record whether `tools/list` answers. Any failure → that preset is deferred; a failure that is the sandbox's rule (not the package's) → all command presets deferred (Decision 9) | Task 10 (command presets only) |
| 11 | Do the gateway's Gemini and Grok models accept the runtime's tool choice (`auto`, and `required` / a named tool if the chat loop ever sends them) through the gateway's protocol? | One hand-run turn each with a tool call, outside CI; if refused, leave that model out of `ALLOWED_MODEL_IDS` (the agent needs tools) | Task 7 acceptance |
