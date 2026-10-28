# Phase 3 — SERP, Intent and Indexability Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then a failing named test, then the code, then one conventional commit), a fresh reviewer
> before the next task starts, and a whole-branch review at the end. Steps use checkbox (`- [ ]`)
> syntax for tracking. Tasks run in order, in one worktree, on `phase-3/serp-intent`.

**Goal:** see a search result page the way an SEO reads it, and see a page the way crawlers and AI
bots fetch it:
- a SERP overlay on result pages the user loads: what the page is made of, who owns page 1, the
  features outlined on the page, and the tab's search parameters, with an honest "couldn't read this
  layout" state;
- selectors that are signed data, updatable without an app release;
- an on-device intent classifier with its confidence shown;
- indexability and AI-readiness probes, as search and AI crawlers fetch the page.

Deliverable: the SERP and Visibility panels.

**Architecture:** Phases 0–2.5 hold:
- page-facing scripts run only in isolated worlds;
- page-derived data is Zod-validated off main's thread;
- the chrome talks to main only through `enforceSender`-first tRPC procedures;
- page text is always inert;
- every request made on the user's behalf goes through the bounded fetcher
  (`specs/fetcher.spec.ts`) and the private-address check (`specs/private-address.spec.ts`).

New in this phase:
- **SERP reading** is driven by a **selector pack**: JSON data (engines, URL patterns, parameter
  names, CSS selectors per result type), never code. It is read by one fixed reader script frost
  ships, run in the tab's own isolated SERP world. The reader's answer is validated and analysed in
  a `worker_threads` worker of the SERP's own (`serp-analysis.cjs`).
- **Packs are signed.** Each pack has a detached Ed25519 signature over its exact bytes. The app
  embeds the public key. A pack is bundled with the app; a newer remote pack replaces it only if its
  signature verifies, it parses, and its version is higher.
- **Intent** runs in an Electron **utility process** (`utilityProcess.fork`): ONNX Runtime, a small
  open-licence sentence-embedding model downloaded on first use and pinned by sha256, and frost's own
  labelled prototype queries. Main talks to it over a typed, Zod-validated message protocol. Behind
  an `IntentClassifier` interface, so tests use a deterministic fake.
- **Probes** fetch the current URL as several crawlers and a normal browser, through the bounded
  fetcher's `checks` lane, only when the user asks.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §2 (On-device ML), §3 (security model), §4 Phase 3.
- UI direction: `docs/ui-reference/README.md`.

## Spec-Driven Development protocol
As before:
- every task authors its `specs/` artifacts first;
- each scenario has a named test that cites it;
- reviewers check spec↔test↔code agreement.

Specs follow the existing split:
- `*.spec.ts`: Zod-free constants and types, importable by the chrome. Strict Trusted Types keep
  Zod out of the renderer bundle.
- `*.schema.ts`: Zod schemas, for main, the workers and `@app/ipc-contract`.
- `*.feature.md`: acceptance scenarios, each naming its test.

## Global Constraints
Everything in the Phase 0–2.5 Global Constraints and `CONTRIBUTING.md` still holds, plus the following.
- **Clean-room.** Result types, labels, intent definitions, prototype queries, thresholds and UI text
  are frost's own, written from SEO practice. Selectors describe the public markup of search
  engines' result pages; they are not taken from any other product. Test SERPs are synthetic pages
  frost writes, never saved copies of real result pages.
- **No background scraping.** frost reads a result page only when the user has loaded it in a tab.
  It never requests a search engine by itself, and probes and pack updates run only on an explicit
  user action.
- **Selectors are data.** A pack holds strings and numbers only: CSS selectors, URL patterns,
  parameter names, labels. The reader treats every selector as untrusted input to
  `querySelectorAll`: an invalid one fails closed (`unreadable`), and its work is bounded by time and
  node caps. Nothing in a pack is evaluated as script.
- **Never guess.** When a pack's required selectors do not match, the panel says "couldn't read this
  layout", with the reason. There is no heuristic fallback that classifies results anyway.
- **Keys.** The private signing key lives only outside the repo (the maintainers' private key
  store). `pnpm sign:selectors` reads its path from `FROST_SERP_SIGNING_KEY`. Tests use ephemeral
  keypairs. The public key is a spec constant.
- **The model is not committed.** Weights are downloaded on first use, only after the user agrees.
  The download is pinned by URL (a fixed revision) and sha256, capped in size, and re-verified each
  time the file is loaded.
- **Utility process.** The utility process gets no Electron APIs beyond `process.parentPort`, an
  explicit minimal `env`, and no `execArgv`. Main reads and verifies the model and vocabulary and
  hands it their bytes, so it never opens a file or socket itself. Every message either way is
  Zod-validated. Electron cannot apply Chromium's OS sandbox to a Node utility process; the
  plan does not claim otherwise (see Known limits).
- **e2e seams** are switches read only by unpackaged builds and refused at startup by packaged
  ones (`PACKAGED_FORBIDDEN_SWITCHES`):
  - `frost-e2e-serp-pack-key`, an extra trusted public key;
  - `frost-e2e-serp-pack-url`, the remote pack URL;
  - `frost-e2e-intent-fake`, the utility process's deterministic fake embedder.
- **Team contract** (Phases 3–7 are built in parallel):
  - new files live in this phase's namespace: `serp-*`, `intent-*` and `visibility-*` specs;
    `apps/desktop/src/main/serp/`, `apps/desktop/src/main/intent/`,
    `apps/desktop/src/workers/intent/`; `serp-router.ts` and `serp-service.ts`; renderer
    `serp-view.ts`, `visibility-view.ts` and their palette and component files;
  - shared hub files change only by small append-only registrations. These are `router.ts`,
    `services.ts`, `index.ts`, `main/index.ts`, `App.tsx`, the panel and palette registries,
    `forge.config.ts`, `package.json` and `security-policy.spec.ts`'s forbidden switches;
  - no DB migration is needed. If one becomes needed, its IDs are `0010`–`0019`.

## Review Focus
- **A forged, tampered, replayed or older pack is never used.**
  - A wrong signature, a wrong key, one changed byte, a valid signature over an invalid pack, a pack
    that is not newer: all keep the current pack.
  - A stored remote pack is verified again at every start.
  - Task 1 (`pack-rejects-forged-and-stale`).
- **The page cannot steer the reader.**
  - The reader runs in the isolated SERP world.
  - Its answer is capped in the world, then validated in the SERP worker.
  - A hostile page (100,000 results, huge strings, throwing getters) gives a bounded answer or
    `unreadable`.
  - Task 3 (`serp-reader-is-bounded`).
- **The utility process is least-privilege, and its protocol is closed.**
  - It gets only bytes and queries, a minimal env, and no network or files of its own.
  - A malformed message is dropped. A crash or hang ends the request with `unavailable` and
    restarts the process on the next request.
  - Task 2 (`intent-host-protocol-is-closed`).
- **Probes cannot become a flood or a LAN probe.**
  - They run only on a user action, one run per tab, at most 6 fetches.
  - They use the `checks` lane, with private-address refusal and caps.
  - Task 5 (`probes-are-bounded`).

---

### Task 1: Signed selector packs
- **Spec:**
  - `specs/serp-selector-pack.schema.ts` (Zod):
    - `SelectorPackSchema`: `format: 1`, an integer `version`, `published`, and `engines[]`. Each
      engine has an `id`, a label, `hosts` (exact host names), `paths`, and `params`: the query,
      `gl`, `hl`, page and offset parameter names. It also has a `layout`: a `results` container
      selector (required), and `blocks[]` of `{ type, container, item?, link?, title?, required? }`;
    - result `type` comes from `SERP_RESULT_TYPES`;
    - caps on engines, blocks, selector length and total bytes (`SELECTOR_PACK_LIMITS`).
  - `specs/serp-selector-pack.spec.ts` (Zod-free):
    - `SERP_PACK_PUBLIC_KEYS` (SPKI DER base64);
    - `SERP_PACK_REMOTE_URL`: the GitHub release asset `serp-selectors.json`, with its `.sig` beside it;
    - `PACK_UPDATE_OUTCOMES`: `installed`, `not-newer`, `bad-signature`, `invalid-pack`,
      `unreachable`, `too-large`, `disabled`;
    - `SERP_RESULT_TYPES` and their labels.
  - `specs/serp-selector-pack.feature.md`.
- **Format.**
  - The `.sig` file is the base64 Ed25519 signature of the pack file's exact bytes.
  - Verification is `crypto.verify(null, bytes, key, sig)` against each embedded key. It runs before
    parsing; Zod runs after.
- **Bundled pack.** `apps/desktop/src/main/serp/packs/serp-selectors.json` and its `.sig`, signed
  with the real key. It covers Google, Bing and DuckDuckGo web results. It is imported as raw text at
  build time and verified at startup like any other pack. A bundled pack that fails verification
  disables SERP reading (`pack-invalid`); it never reads unsigned.
- **Remote pack.** `checkForUpdate()` fetches the pack and its signature through the bounded
  fetcher's `checks` lane:
  - https only, about 256 KB, 10 s;
  - verify, parse, compare versions;
  - on success, write it atomically to `userData/serp-selectors/` and use it at once.

  At start, the stored pack is verified again and used only if it is still newer than the bundled
  one. It runs only on a user action: the SERP panel's "Check for selector updates" and the palette.
  The URL is the spec constant; unpackaged builds may override it with `frost-e2e-serp-pack-url`.
- **Signing.**
  - `scripts/sign-selectors.mjs` signs a pack (`--verify` checks one), reading the private key path
    from `FROST_SERP_SIGNING_KEY`;
  - the root script is `pnpm sign:selectors <pack.json>`.
- **Files:**
  - `apps/desktop/src/main/serp/pack-verify.ts` (verify plus parse, pure);
  - `apps/desktop/src/main/serp/pack-store.ts` (bundled, stored and remote; injected fs and fetch);
  - `apps/desktop/src/main/serp/packs/*`;
  - `scripts/sign-selectors.mjs`;
  - a root `package.json` script line;
  - one new entry in `PACKAGED_FORBIDDEN_SWITCHES` per e2e seam.
- **Failing tests first:** `apps/desktop/src/main/serp/__tests__/pack-verify.test.ts` and
  `pack-store.test.ts`:
  - with an ephemeral keypair: a valid pack is accepted;
  - a changed byte, a wrong key, a truncated signature and non-base64 are refused;
  - a valid signature over an invalid pack is refused;
  - an older or equal version is `not-newer`;
  - an oversize pack is `too-large` (never read past the cap);
  - a stored pack is used at start only if it verifies and is newer;
  - a corrupt stored pack falls back to the bundled one;
  - the bundled pack verifies with the embedded key (`bundled-pack-is-signed`);
  - the sign script signs and verifies, and refuses without the env var.
- [x] commit `feat(serp): signed selector packs`
- [ ] Review fixes: commit `fix(serp): address selector pack review findings`

### Task 2: On-device intent classifier
Done second: its native packaging is the riskiest part, so the macOS packaging gate runs early.
- **Spec:**
  - `specs/intent-classifier.spec.ts` (Zod-free):
    - `INTENT_LABELS`: `informational`, `navigational`, `commercial`, `transactional`, with frost's
      own one-line definitions;
    - `INTENT_MODEL`: name, licence (Apache-2.0), pinned revision URLs for the int8 ONNX model and
      `vocab.txt`, the sha256 and byte size of each;
    - `INTENT_LIMITS`: query length, a timeout per request, the restart backoff;
    - `INTENT_STATES`: `model-missing`, `downloading`, `ready`, `unavailable`.
  - `specs/intent-classifier.schema.ts` (Zod): `IntentResultSchema` (the label, a confidence from 0
    to 1, a score per label, and the model id or `fake`), and the utility-process message protocol
    (`IntentRequestSchema`, `IntentResponseSchema`: `load`, `classify`, `ping`).
  - `specs/intent-classifier.feature.md`.
- **Classifier.**
  - `IntentClassifier { state(); ensureModel(); classify(query) }`.
  - The real one embeds the query with the model (WordPiece tokenizer frost writes, mean pooling,
    L2-normalised). It compares the embedding with per-label centroids of frost's own prototype
    queries (embedded once per load). A softmax over the cosine similarities, with a fixed
    temperature, gives the confidence.
  - Plain query cues (a price or "buy" word, "near me", a bare domain) only nudge the scores. Their
    weights are spec constants.
  - The fake is a deterministic keyword-based classifier for unit tests and e2e, behind the same
    interface.
- **Runtime.**
  - `onnxruntime-node` (MIT) in the utility process. The Core ML execution provider is tried first on
    macOS arm64, with CPU as the fallback.
  - The Forge build adds a `intent-worker` entry (`src/workers/intent/index.ts`, its own
    `vite.intent.config.ts` with `onnxruntime-node` external).
  - A packaging hook copies `onnxruntime-node` and `onnxruntime-common`, with only the target
    platform and architecture binaries, into the package. `asar.unpack` takes `*.node`, `*.dylib` and
    `*.so*`.
  - `THIRD_PARTY_NOTICES` gains them.
  - `verify:mac` checks the binding is unpacked and loads in the packaged app's utility process (a
    self-test switch that only loads the runtime and exits).
- **Fallback.** If the native module cannot pass `make:mac` / `verify:mac` (fuses, ASAR integrity,
  signature), switch the utility process to `onnxruntime-web` (WASM, CPU). Record the decision and
  the reason under As built.
- **Model download.**
  - `main/intent/model-store.ts` downloads the model and vocabulary on the user's "Enable on-device
    intent" (the SERP panel or the palette). The prompt states the size and host.
  - The download uses the bounded fetcher's `checks` lane, with a per-call cap of the pinned size
    plus slack and a long deadline.
  - The sha256 is checked before writing, atomically, to `userData/models/`. A mismatch is never
    kept.
  - Each load hashes the file again.
- **Files:**
  - `apps/desktop/src/main/intent/{classifier.ts, fake.ts, model-store.ts, host.ts}` (`host.ts`
    covers fork, lifecycle and the typed protocol);
  - `apps/desktop/src/workers/intent/{index.ts, tokenizer.ts, embed.ts, prototypes.ts}`;
  - `apps/desktop/vite.intent.config.ts`;
  - one `forge.config.ts` build entry, plus the packaging hook;
  - `apps/desktop/package.json` dependency.
- **Failing tests first:**
  - the tokenizer (basic and WordPiece on a small vocabulary: accents, punctuation, CJK, unknown
    words, the length cap);
  - pooling and normalisation;
  - the prototype classifier (centroids, softmax, cue nudges) on fixed vectors;
  - protocol schemas: malformed messages are dropped;
  - the host, with a fake child: a request times out to `unavailable`, a crash restarts once, and
    the env is minimal;
  - model-store: a sha mismatch is refused and never written, an oversize download is refused, and a
    corrupt file on load is `model-missing`;
  - the fake's determinism;
  - packaging: the hook's file selection, and the unpack glob, in `forge-config.test.ts`.
  - The real-model test (`intent-model.test.ts`) classifies a few clear queries. It is skipped when
    the pinned files are not cached (`FROST_INTENT_MODEL_DIR`, default `~/.cache/frost-models`).
- [x] commit `feat(intent): on-device intent classifier in a utility process`
- [ ] Review fixes: commit `fix(intent): address intent classifier review findings`

### Task 3: SERP reading
- **Spec:**
  - `specs/serp-search-params.schema.ts` (Zod; Phase 6 imports it): `SearchParamsSchema` with the
    engine id, query, `gl`, `hl`, the device (`desktop` / `mobile` / `tablet`, from the tab's render
    profile), the page number, and the result URL.
  - `specs/serp-snapshot.schema.ts` (Zod): the reader's raw answer (`SerpReadSchema`) and the
    analysed `SerpSnapshotSchema`, which holds:
    - the search parameters;
    - results `{ position, type, title, url, domain }`;
    - composition counts per type;
    - page-1 ownership by registrable domain (positions and share);
    - the pack version;
    - or `unreadable` with a reason.
  - `specs/serp.spec.ts` (Zod-free):
    - `SERP_WORLD_ID`;
    - `SERP_READ_LIMITS` (results, strings, nodes and time);
    - `SERP_UNREADABLE_REASONS`, with messages: `no-container`, `no-results`, `bad-selector`,
      `timeout`, `invalid-answer`, `pack-invalid`;
    - `SERP_DEVICES`.
  - `specs/serp-overlay.feature.md`.
- **Detection.** `engines.ts` matches a URL against the active pack: an exact host, a path, and the
  query parameter present. The search parameters come from the URL by the pack's parameter names,
  and the device from the tab's render profile.
- **Reader.**
  - `read-script.ts` is a self-contained function, serialised with the pack's layout as JSON
    arguments.
  - It runs only in `SERP_WORLD_ID` and uses `querySelectorAll` inside try/catch.
  - It caps counts and strings and stops at a time budget. It reads text and `href` only.
  - It answers raw blocks in document order.
- **Analysis** (`serp-analyse.ts`, in `serp-worker.ts`):
  - Zod-validate the answer, then assign positions;
  - organic results take their own count, and features their own slot;
  - count the composition;
  - group page-1 results by registrable domain (`@app/seo-core` `registrableDomain`);
  - `unreadable` when the results container is missing, or when no block matched at all.
- **Files:**
  - `apps/desktop/src/main/serp/{engines.ts, read-script.ts, serp-analyse.ts, serp-worker.ts}`;
  - a forge build entry `serp-analysis`.
- **Failing tests first:**
  - parameters per engine (Google `gl`/`hl`/`start`, Bing `cc`/`setlang`/`first`, DuckDuckGo `kl`);
  - non-SERP URLs are never matched;
  - the reader under jsdom on synthetic fixture SERPs frost writes (one per engine): composition,
    order and positions;
  - an unreadable layout, an invalid selector, the time budget;
  - a hostile page (`serp-reader-is-bounded`);
  - ownership share;
  - the bundled pack against each fixture.
- [ ] commit `feat(serp): read result pages with the selector pack`
- [ ] Review fixes: commit `fix(serp): address SERP reading review findings`

### Task 4: SERP service, router and outlines
- **Spec:**
  - `specs/serp-service.schema.ts` (Zod): the stable read API's answers, which are `SerpStateSchema`
    (`not-serp` / `pending` / `ready` / `unreadable`, with the snapshot and its document),
    `IntentAnswerSchema` and `PackStatusSchema`;
  - router inputs;
  - `serp-overlay.feature.md` gains Router and Outlines sections.
- **Service** (`main/serp/service.ts`, wired by `main/serp/setup.ts` with one call from
  `main/index.ts`):
  - per-tab state keyed by document and URL;
  - a read after `did-finish-load` and after in-page navigations of SERP URLs (debounced);
  - a new document drops the state;
  - a `watch` long-poll, as `checks.watch` does;
  - the pack's status and `checkForUpdate`;
  - the intent of the current query, when the model is ready.
- **Outlines.**
  - `outline.ts` draws each read block's box with its type label in the SERP world, as Phase 2's
    highlight draws its overlay: one host element, a closed shadow root, CSSOM styles.
  - Toggled from the panel, it follows scrolling.
  - It is removed on navigation, on a tab switch, when the toggle is turned off, or when the panel
    is left.
- **Procedures** (`packages/ipc-contract/src/serp-router.ts`, registered once as `serp`, every one
  `enforceSender`-first):
  - `serp.watch`, `serp.state`;
  - `serp.setOutlines`;
  - `serp.checkPackUpdate`, `serp.packStatus`;
  - `serp.intentState`, `serp.enableIntent`, `serp.classify`;
  - Task 5 adds `serp.runProbes`, `serp.probes` and `serp.stopProbes`.
- **Read API** (`serp-service.ts`): a `SerpService` interface the router uses, and the exported
  `SerpReadApi` subset for Phase 5 (see Interfaces).
- **Files:**
  - `packages/ipc-contract/src/{serp-router.ts, serp-service.ts}`;
  - one line each in `router.ts`, `services.ts`, `index.ts`;
  - `apps/desktop/src/main/serp/{service.ts, setup.ts, outline.ts}`;
  - `main/index.ts` registration lines.
- **Failing tests first:**
  - router: each procedure refuses a foreign sender, and fails closed without the service;
  - service with fakes: a read on a SERP load, none on other pages, state per tab, a new document
    resets, the watch wakes;
  - outlines plan: boxes and labels per type;
  - a pack update swaps the pack live.
- [ ] commit `feat(serp): SERP service, router and outlines`
- [ ] Review fixes: commit `fix(serp): address SERP service review findings`

### Task 5: Indexability and AI-readiness probes
- **Spec:**
  - `specs/visibility-probes.spec.ts` (Zod-free):
    - `PROBE_AGENTS`: id, label, the user-agent string to send, the robots.txt product token and the
      X-Robots-Tag / meta name it obeys, for Googlebot (smartphone), Bingbot, GPTBot, ClaudeBot,
      PerplexityBot and a normal browser (frost's own user agent, the baseline);
    - `PROBE_LIMITS`: 6 fetches per run, 5 MB, 10 s each, at most 2 at once;
    - `PROBE_DIFF_TOLERANCE`;
    - probe statuses and labels.
  - `specs/visibility-probes.schema.ts` (Zod): `ProbeReportSchema`, one row per agent with:
    - status and redirect hops;
    - the robots.txt verdict for its token;
    - meta robots and X-Robots-Tag (general and agent-specific);
    - canonical;
    - byte size, word count and a sha256 of the visible text;
    - a diff against the browser baseline.
  - `specs/visibility-probes.feature.md`.
- **Run.** "Run visibility probes" (the Visibility panel or the palette) starts a run on the active
  tab's current URL:
  - each agent's GET goes through the `checks` lane, `page` the tab's URL, `userAgent` the agent's;
  - robots.txt is read once through main's robots.txt fetcher and decided per token with
    `@app/seo-core` `matchRobots`;
  - the bodies are parsed in the served-HTML worker (`parseServed`), and the text hash is computed
    there;
  - results stream through `serp.probes`.

  A new document, Stop, a closed tab or Clear Browsing Data cancels the run.
- **Honesty.** A user-agent string does not reproduce a crawler's network origin, rendering service
  or IP verification. Sites that verify bots answer differently. Every surface says so, with
  `FETCH_DISCLOSURE`.
- **Files:**
  - `apps/desktop/src/main/serp/{probes.ts, probe-compare.ts}`;
  - router procedures in `serp-router.ts`.
- **Failing tests first:**
  - per-agent rows: a redirect only for one agent, robots disallowed for GPTBot only, `X-Robots-Tag:
    googlebot: noindex`, `<meta name="claudebot">`, a canonical that differs, content smaller than
    the baseline;
  - bounded: 6 fetches, at most 2 at once, a private host refused, no run without the action, cancel
    on a new document (`probes-are-bounded`).
- [ ] commit `feat(serp): indexability and AI-readiness probes`
- [ ] Review fixes: commit `fix(serp): address probes review findings`

### Task 6: SERP and Visibility panels, palette, e2e
- **Spec:** `specs/serp-panels.feature.md`, plus two `SEO_PANELS` entries (`serp`, `visibility`).
- **SERP panel.**
  - The search parameters bar: the engine, query, `gl`/`hl`, device and page, always visible for the
    tab.
  - The intent chip, with its confidence, and "Enable on-device intent" when the model is missing.
  - The composition as a bar and a count per type, the page-1 ownership table, and the results list.
  - "Outline features on the page".
  - The pack version and "Check for selector updates".
  - "Not a search result page", and "Couldn't read this layout" with its reason and the update
    action.
  - It renders without waiting for the audit.
- **Visibility panel.** "Run visibility probes", then a table with a column per agent and a row per
  fact, the differences marked, the honesty note and Stop. A query box classifies any typed query
  (local only).
- **Palette** (`serp-palette.ts`, one `registerPaletteActions` call; its panels in
  `FEATURE_PANEL_JUMPS`):
  - "Open SERP panel", "Open Visibility panel";
  - "Outline SERP features", "Check for selector updates";
  - "Enable on-device intent", "Run visibility probes".
- **Files:**
  - `apps/desktop/src/renderer/{serp-view.ts, visibility-view.ts, serp-palette.ts}`;
  - `components/seo/{Serp.tsx, Visibility.tsx, serp-icons.tsx}`;
  - `hooks/useSerp.ts`;
  - appended styles;
  - one-line registrations in `seo-sidebar.spec.ts`, `SeoSidebar.tsx` and `command-palette.spec.ts`.
- **Failing tests first:**
  - view models (composition bars, ownership rows, parameter labels, probe diff marks) and palette
    availability;
  - e2e (`e2e/serp.e2e.ts`, `e2e/visibility.e2e.ts`), with synthetic SERPs on a loopback server
    under a public-looking name:
    - a pack signed by the test with an ephemeral key, trusted through `frost-e2e-serp-pack-key` and
      installed through "Check for selector updates" from `frost-e2e-serp-pack-url`;
    - composition and ownership shown;
    - search parameters differ per tab;
    - outlines drawn, invisible to the page's main world, gone on navigation;
    - an unreadable layout state;
    - intent from the fake engine in the real utility process;
    - probes against a site with per-agent robots.txt and headers;
    - nothing is requested before the user acts.
- [ ] commit `feat(chrome): SERP and Visibility panels`
- [ ] Review fixes: commit `fix(chrome): address SERP panels review findings`

### Task 7: Release check and docs
- [ ] Whole-branch review; `make:mac` / `verify:mac` green on the macOS runner.
- [ ] README status, `apps/desktop/README.md` and this plan's As built: commit `docs: phase 3 serp, intent and indexability`.

## Interfaces for other phases
Stable after merge. Import the schemas from `@app/specs/...` and the types from `@app/ipc-contract`.
- **Phase 6 (change intelligence):** `specs/serp-search-params.schema.ts`, `SearchParamsSchema` /
  `SearchParams`. This is the search parameters to record with each capture: engine, query, `gl`,
  `hl`, device, page, URL.
- **Phase 5 (agent tools):** `packages/ipc-contract/src/serp-service.ts` exports `SerpReadApi`. Each
  answer is Zod-typed by `specs/serp-service.schema.ts`, and none of these calls fetch anything:
  - `snapshot(tabId) → SerpState`: `SerpStateSchema`, the tab's SERP reading (`not-serp`,
    `pending`, `ready` with a `SerpSnapshot`, or `unreadable` with its reason);
  - `classifyIntent(query) → Promise<IntentAnswer>`: `IntentAnswerSchema`, either `ready` with an
    `IntentResult` or a state such as `model-missing`. It never downloads the model; only the user
    enables it;
  - `probes(tabId) → ProbesState`: `ProbesStateSchema`, the tab's last probe run.

  Starting probes stays a user action: an agent tool must go through Phase 5's approval model and
  call `runProbes(tabId)`, which the interface marks as fetching.

## Self-review notes
- **Covered:**
  - the SERP overlay with composition, ownership, outlines, parameters and the unreadable state
    (Tasks 3, 4, 6);
  - signed packs (1);
  - intent (2);
  - probes (5);
  - panels (6).
- **Deferred:**
  - publishing the first remote pack as a GitHub release asset (a maintainer action with the
    private key);
  - automatic, scheduled pack checks (opt-in, later);
  - engines beyond Google, Bing and DuckDuckGo web results.
