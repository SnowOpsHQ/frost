# Feature: Page type

Spec: `specs/page-type.spec.ts` (`PAGE_TYPES`, `PAGE_TYPE_LABELS`, `PAGE_TYPE_SIGNALS`,
`PAGE_TYPE_SIGNAL_LABELS`, `PAGE_TYPE_SCHEMA_MAP`, `PAGE_TYPE_OG_MAP`, `PAGE_TYPE_PATH_MATCHES`,
`PAGE_TYPE_PATH_HINTS`, `PAGE_TYPE_STRUCTURE`, `PAGE_TYPE_CONFIDENCE`, `PAGE_TYPE_CONFIDENCE_LABELS`,
`PAGE_TYPE_COPY`), with `specs/intent-classifier.spec.ts` (`IntentState`, `IntentAnswer`). Phase 9
Task 8 (Decision 14). Each line maps to one named test.

## Decisions
- **On this device, deterministic, always on.** seo-core works out `audit.pageType` (`home`,
  `article`, `product`, `listing`, `documentation`, `contact`, `landing`, `other`) with its
  `confidence` and the signals that decided it, in the analysis worker with the rest of the audit.
  It sends nothing anywhere, and needs no consent.
- **Existing snapshot fields only.** JSON-LD `@type` (the Schema panel's reading), `og:type`, the URL
  path and a structure signal from the heading list, the link list, the word count and the heading
  total. Nothing new runs in the page; no extractor or snapshot-schema change.
- **A fact, not a rule.** No rule is added to `SEO_RULE_SPECS`, and the health score never reads it.
- **Honest about doubt.** Structured data wins a conflict, but then the confidence is `unsure`; no
  signal is `other`, `unsure`. The root path (`/` → `home`) is a signal like any other.
- **Intent of the target query.** The Overview's "Page" card shows the intent of the page's stored
  target query (`content.getNotes`), classified by the existing on-device classifier
  (`serp.classify`), only when a target is set and on-device intent is `ready`. Otherwise it
  classifies nothing and shows no intent.

## Heuristic (`packages/seo-core/src/__tests__/page-type.test.ts`)
- `schema-wins` — a JSON-LD `BlogPosting` with `og:type` `article` is an `article` at `high`; with a
  `Product` entity and an `og:type` of `article`, the type is `product` (structured data wins) and the
  confidence is `unsure`; the first mapped top-level entity decides; types outside the map say nothing.
- `path-hint-only-is-low` — with no structured data, no `og:type` and an ordinary structure, a page
  under `/blog/` is an `article` at `low` with one `url-path` signal; `/blog/` itself says nothing;
  `/docs/…` is `documentation`, `/products/…` `product`, `/contact` `contact`, `/pricing` `landing`;
  the deepest matching segment decides (`/blog/tag/seo` is a `listing`).
- `conflict-is-unsure` — signals naming two types are `unsure`; no signal is `other`, `unsure`.
- `home-by-root-path` — the root path (no query) alone is `home` at `low`, an ordinary `url-path`
  signal; on `/`, a `CollectionPage` conflicts: `listing` (structured data wins), `unsure`, with
  both signals shown; a listing structure on `/` conflicts too (`home`, `unsure`); `/?p=1` is not
  the root.
- `listing-by-repeated-headings-and-links` — from snapshot counts only: six or more headings of one
  level below H1, at least 30 internal links and few words per heading make a `structure` signal for
  `listing`; prose (many words per heading), few links or mixed heading levels do not.

## Purity (`packages/seo-core/src/__tests__/purity.test.ts`)
- `pure-no-network` — `page-type/` imports only seo-core modules and Zod-free specs, and names no
  network, timer, storage or DOM API; the audit's `pageType` is the same for the same snapshot.

## Overview "Page" card (`apps/desktop/src/renderer/__tests__/overview-page-type.test.ts`)
- `shows-type-and-signals` — the card shows the page type's label, its confidence and each signal
  with what it names and its evidence; an `unsure` conflict says so.
- `intent-only-with-target-and-enabled-intent` — with a stored target query and intent `ready`, the
  card calls `serp.classify` once with that query and shows the intent chip beside it.
- `no-intent-otherwise` — with no target query, or intent not `ready`, `serp.classify` is never
  called and no intent is shown (the card says why).
