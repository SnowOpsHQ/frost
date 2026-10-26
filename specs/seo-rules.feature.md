# Feature: on-page SEO rules and the health score

Spec: `specs/seo-rules.spec.ts` (`SEO_RULE_SPECS`, thresholds, `SEVERITY_WEIGHTS`, `SCORE_BANDS`)
and `specs/seo-snapshot.spec.ts` (`PageSnapshot`). Phase 2 Task 1; the image loading and size and
the social rules are Task 2 (`seo-panels.feature.md`); the structured-data rules (category `schema`)
are Task 3, with their scenarios in `seo-schema.feature.md` (tests in `schema-rules.test.ts`). Implemented by
`packages/seo-core` (`@app/seo-core`): pure TypeScript, no Electron, DOM or Zod. Each rule scenario
maps to one named test in `packages/seo-core/src/__tests__/rules.test.ts` with a **passing** and a
**failing** fixture snapshot (`fixtures.ts`: a clean page every rule passes on, changed as each
scenario says).

A rule is `{ id, category, severity, title, why, fix, check(snapshot) }`; `check` answers `null`
(pass) or the finding's details: `facts` (labelled values, e.g. the title and its length) and up to
`FINDING_SAMPLE_LIMIT` `samples` (the offending values: image sources, link targets …), plus `count`
where the rule counts elements. Lengths are code points of the normalised value
(`CappedText.length`). Rules about "the title", "the meta description" and "the canonical" look at
the first of each (for the description: the first one **with text**, so an empty tag before it
changes nothing); rules over images and links look at the snapshot's (capped) lists.

## Catalog (`rules.test.ts`)
- **Scenario: catalog-matches-spec** — `RULES` has exactly the ids of `SEO_RULE_SPECS`, in the same
  order, each with the spec's category, severity, title, why and fix.
- **Scenario: clean-fixture-passes-every-rule** — the clean fixture fails no rule (`runAudit` has no
  findings, score 100). Its structured data (an Organization, its WebSite and the Article in one
  `@graph`) passes every `schema` rule.
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
- **Scenario: meta-description-missing** — fails with none, or only empty ones; passes with text,
  also when an empty one comes first.
- **Scenario: meta-description-too-short** — fails below `DESCRIPTION_MIN_CHARS`; passes at it;
  measures the first description with text (an empty one before a short one still fails, an empty
  one before a good one passes).
- **Scenario: meta-description-too-long** — fails above `DESCRIPTION_MAX_CHARS`; passes at it;
  measures the first description with text.
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
- **Scenario: robots-noindex** — fails for `noindex` (any case, among other tokens) and `none` in
  the generic `robots` tag, and in a `googlebot`, `googlebot-news` or `bingbot` tag alone; the
  finding's facts name each tag (`Meta robots (googlebot)` → `noindex`); passes for `index, follow`,
  with no robots meta, and for `noindex` in a tag frost does not read.
- **Scenario: robots-nofollow** — fails for `nofollow` and `none` (generic or crawler-specific,
  named likewise); passes for `noindex` alone.

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

## Image loading and size (Phase 2 Task 2)
- **Scenario: images-missing-dimensions** — fails for a rendered image without a `width` or a
  `height` attribute, or with an empty one (count, samples: sources); passes with both, for an image
  CSS sizes (`cssSized`: a computed `aspect-ratio`, or `width` and `height` declared together), and
  for an image with no layout box (`rendered` `null`).
- **Scenario: images-oversized** — fails when the file's width or height (`natural`, corrected for
  `srcset` density by the extractor) is more than
  `IMAGE_OVERSIZE_FACTOR` × the rendered one (samples: source, natural and rendered sizes); passes at
  exactly the factor, when either size is unknown, for a rendered size of 0, and for SVG images (by
  extension, any case, query ignored, or a `data:image/svg+xml` URL).
- **Scenario: images-lazy-in-first-viewport** — fails for `loading="lazy"` (any case) on an image in
  the first viewport (count); passes for lazy images below it and eager or unset ones in it.

## Links
- **Scenario: links-empty-anchor** — fails when a link's text is `''` (count, samples: targets);
  passes when every link has text.
- **Scenario: links-javascript-href** — fails for a `javascript:` link; passes for `http(s)` and
  `mailto:` links.
- **Scenario: links-nofollow** — fails when a link's `rel` has the token `nofollow` (count); passes
  for `noopener` and `sponsored` only.

## Social (Phase 2 Task 2)
- **Scenario: og-title-missing** — fails for no `og:title` (`None`) or an empty one (`Empty`);
  passes with text.
- **Scenario: og-description-missing** — fails for none or an empty one; passes with text.
- **Scenario: og-image-missing** — fails for none or an empty one, also when only `twitter:image`
  is set; passes with one.
- **Scenario: og-image-not-https** — fails for a relative value (`/img.png`, `img.png`,
  `//cdn/img.png`: `Relative URL`) and for another scheme (`http:`: `http: URL`); passes for
  `https://` (any case); not reported when there is no `og:image`.
- **Scenario: twitter-card-missing** — fails for no `twitter:card`; passes with one.

## URL
- **Scenario: url-too-long** — fails above `URL_MAX_CHARS` without the fragment; passes at it, and
  a long `#fragment` alone never fails.
- **Scenario: url-uppercase** — fails for an uppercase letter in the path; passes when only the host
  or query has one, and for percent-escapes (`/wiki/%E6%9D%B1%E4%BA%AC`), but fails when a letter
  outside them is uppercase (`/Wiki/%E6`).
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
- **Scenario: score-caps-noindex** — `robots-noindex` alone scores `NOINDEX_SCORE_CAP` (59, band
  `poor`) instead of 93, the audit is `indexable: false` and its page facts name the tags that ask
  (`noindexFor`); a lower score with noindex stays lower; without it the audit is `indexable`.
- **Scenario: panel-status** — `panelStatus` is `error` with an error in the panel's categories,
  `warn` with a warning and no error, `pass` with only info findings or none.
- **Scenario: page-facts-summarise-links-images-and-social** — the audit's facts count internal,
  external, other and nofollow links, images and images without alt over the snapshot's lists, and
  carry the page's totals, the lists themselves (the Links and Images panels' rows) and the social
  tags.
