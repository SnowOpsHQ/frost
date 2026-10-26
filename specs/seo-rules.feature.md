# Feature: on-page SEO rules and the health score

Spec: `specs/seo-rules.spec.ts` (`SEO_RULE_SPECS`, thresholds, `SEVERITY_WEIGHTS`, `SCORE_BANDS`)
and `specs/seo-snapshot.spec.ts` (`PageSnapshot`). Phase 2 Task 1. Implemented by
`packages/seo-core` (`@app/seo-core`): pure TypeScript, no Electron, DOM or Zod. Each rule scenario
maps to one named test in `packages/seo-core/src/__tests__/rules.test.ts` with a **passing** and a
**failing** fixture snapshot (`fixtures.ts`: a clean page every rule passes on, changed as each
scenario says).

A rule is `{ id, category, severity, title, why, fix, check(snapshot) }`; `check` answers `null`
(pass) or the finding's details: `facts` (labelled values, e.g. the title and its length) and up to
`FINDING_SAMPLE_LIMIT` `samples` (the offending values: image sources, link targets …), plus `count`
where the rule counts elements. Lengths are code points of the normalised value
(`CappedText.length`). Rules about "the title", "the meta description" and "the canonical" look at
the first of each; rules over images and links look at the snapshot's (capped) lists.

## Catalog (`rules.test.ts`)
- **Scenario: catalog-matches-spec** — `RULES` has exactly the ids of `SEO_RULE_SPECS`, in the same
  order, each with the spec's category, severity, title, why and fix.
- **Scenario: clean-fixture-passes-every-rule** — the clean fixture fails no rule (`runAudit` has no
  findings, score 100).
- **Scenario: title-matching-h1-is-fine** — a title equal to the H1 fails no title or heading rule.

## Title
- **Scenario: title-missing** — fails with no `<title>`; passes with one.
- **Scenario: title-empty** — fails when the first title's text is `''`; passes with text. Not
  reported with `title-missing`.
- **Scenario: title-multiple** — fails with two titles (facts: the count); passes with one.
- **Scenario: title-too-short** — fails below `TITLE_MIN_CHARS` (facts: the title and its length);
  passes at exactly `TITLE_MIN_CHARS`; not reported for a missing or empty title.
- **Scenario: title-too-long** — fails above `TITLE_MAX_CHARS`, measured by the full length even
  when the kept text is capped; passes at exactly `TITLE_MAX_CHARS`.

## Meta description
- **Scenario: meta-description-missing** — fails with none, or an empty first one; passes with text.
- **Scenario: meta-description-too-short** — fails below `DESCRIPTION_MIN_CHARS`; passes at it.
- **Scenario: meta-description-too-long** — fails above `DESCRIPTION_MAX_CHARS`; passes at it.
- **Scenario: meta-description-multiple** — fails with two; passes with one.

## Headings
- **Scenario: h1-missing** — fails with no H1 (an H2 alone is not one); passes with one.
- **Scenario: h1-multiple** — fails with two H1s (samples: their texts); passes with one.
- **Scenario: h1-empty** — fails when an H1 has text `''`; passes when every H1 has text.
- **Scenario: heading-level-skipped** — fails for H1 → H3 (samples: `H1 → H3` with the deeper
  heading's text); passes for H1 → H2 → H3 → H2 and when going back up any number of levels; the
  first heading may be any level.

## Canonical
- **Scenario: canonical-missing** — fails with none; passes with one.
- **Scenario: canonical-multiple** — fails with two (samples: their hrefs); passes with one.
- **Scenario: canonical-relative** — fails for `/page` and `//host/page`; passes for `https://…`.
- **Scenario: canonical-off-host** — fails when the canonical's host differs from the page's;
  passes for the same host, and for `www.` added or removed.
- **Scenario: canonical-og-url-mismatch** — fails when `og:url` names another URL; passes when it
  matches (a `#fragment` ignored), and when either is absent.
- **Scenario: canonical-has-query** — fails for a canonical with `?query`; passes without one.

## Indexing
- **Scenario: robots-noindex** — fails for `noindex` (any case, among other tokens) and `none`;
  passes for `index, follow` and with no robots meta.
- **Scenario: robots-nofollow** — fails for `nofollow` and `none`; passes for `noindex` alone.

## Language and mobile
- **Scenario: lang-missing** — fails for `lang` `null`; passes for `en`.
- **Scenario: viewport-missing** — fails for no viewport and an empty one; passes with one.

## Content
- **Scenario: content-thin** — fails below `THIN_CONTENT_WORDS` words; passes at it, and passes
  when the count is `textTruncated` (incomplete counts never accuse a page of being thin).

## Images
- **Scenario: images-missing-alt** — fails when an image's `alt` is `null` (count: how many;
  samples: their sources); passes when every image has an alt, including `alt=""`.
- **Scenario: image-alt-too-long** — fails above `IMAGE_ALT_MAX_CHARS` (by full length); passes at it.

## Links
- **Scenario: links-empty-anchor** — fails when a link's text is `''` (count, samples: targets);
  passes when every link has text.
- **Scenario: links-javascript-href** — fails for a `javascript:` link; passes for `http(s)` and
  `mailto:` links.
- **Scenario: links-nofollow** — fails when a link's `rel` has the token `nofollow` (count); passes
  for `noopener` and `sponsored` only.

## URL
- **Scenario: url-too-long** — fails above `URL_MAX_CHARS` without the fragment; passes at it, and
  a long `#fragment` alone never fails.
- **Scenario: url-uppercase** — fails for an uppercase letter in the path; passes when only the host
  or query has one.
- **Scenario: url-underscores** — fails for `_` in the path; passes when only the query has one.

## Audit and score (`audit.test.ts`)
- **Scenario: run-audit-ranks-findings** — `runAudit` answers every failing rule once, errors
  first, then warnings, then info, each group in catalog order; the counts per severity match.
- **Scenario: score-is-100-without-findings** — no findings → 100, band `good`.
- **Scenario: score-weights-by-severity** — one error 80, one warning 93, one info 99, an error and
  three warnings 64 (`SEVERITY_WEIGHTS`, rounded).
- **Scenario: score-counts-each-rule-once** — fifty images without alt weigh the same as one.
- **Scenario: score-is-monotonic** — adding a finding never raises the score; it stays in 0–100.
- **Scenario: score-bands** — 90 → `good`, 89 and 60 → `fair`, 59 and 0 → `poor`.
- **Scenario: panel-status** — `panelStatus` is `error` with an error in the panel's categories,
  `warn` with a warning and no error, `pass` with only info findings or none.
- **Scenario: page-facts-summarise-links-and-images** — the audit's facts count internal, external,
  other and nofollow links, images and images without alt over the snapshot's lists, and carry the
  page's totals.
