import { createHash } from 'node:crypto';
import { canonicalJson, snapshotIdentityJson } from '@app/change-intel';
import { scoreAudit, type SchemaEntity, type SeoAudit } from '@app/seo-core';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { MAX_SNAPSHOT_JSON_BYTES } from '@app/specs/capture-db.spec';
import { CAPTURE_LIMITS as L, CAPTURE_SNAPSHOT_VERSION, PAGE_REGIONS, type CaptureJsonLdBlock, type CaptureSnapshot, type PageRegion } from '@app/specs/capture.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { isCapturedRule, type RegionAnswer } from '@app/specs/changes.spec';
import type { RenderProfile } from '@app/specs/render-profile.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// Building a capture snapshot in main (Phase 6 Task 3; spec `capture.spec.ts`; acceptance
// `changes-capture.feature.md`, The snapshot): from the tab's ready audit and the validated region
// answer, every value normalised and cut to `CAPTURE_LIMITS` here, so `CaptureSnapshotSchema` never
// refuses a real page for its size. Also the lane key and the identity hash the store keys on.

/** Lowercase hex SHA-256 of `text`'s UTF-8 bytes. */
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `url` as `@app/db` stores a page (`noteUrl`): an `http(s)` URL of at most `MAX_STORED_URL_LENGTH`,
 * without userinfo or `#fragment`; else `null`.
 */
export function storedPageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_STORED_URL_LENGTH) return null;
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href.length <= MAX_STORED_URL_LENGTH ? parsed.href : null;
}

/**
 * The lane a capture belongs to (`ci_versions.lane_key`): the SHA-256 of
 * `canonicalJson({ url, renderProfile, searchParams })`, the URL in its stored form. `null` when the
 * URL is not a storable page.
 */
export function laneKeyFor(url: string, renderProfile: RenderProfile | null, searchParams: SearchParams | null): string | null {
  const stored = storedPageUrl(url);
  return stored === null ? null : sha256Hex(canonicalJson({ url: stored, renderProfile, searchParams }));
}

/** What makes the version distinct (`ci_versions.snapshot_hash`): the SHA-256 of `snapshotIdentityJson`. */
export const identityHash = (snapshot: CaptureSnapshot): string => sha256Hex(snapshotIdentityJson(snapshot));

/** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = max - (/[\ud800-\udbff]/.test(s.charAt(max - 1)) ? 1 : 0);
  return s.slice(0, end);
}
/** Text as the snapshot keeps it: NFC, whitespace collapsed, trimmed, cut (read only as far as the cap can reach). */
const text = (value: string, max: number): string => cut(cut(value, max * 4).normalize('NFC').replace(/\s+/g, ' ').trim(), max);
const headText = (value: string | null | undefined): string | null => (typeof value === 'string' ? text(value, L.maxHeadChars) : null);
const urlText = (value: string | null | undefined): string | null => (typeof value === 'string' ? cut(value.trim(), L.maxUrlChars) : null);
const safeCount = (n: number): number => (Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), Number.MAX_SAFE_INTEGER) : 0);
/** Sorted (UTF-16 order), unique, non-empty, each cut to `maxChars`, at most `max`. */
const sortedSet = (values: Iterable<string>, maxChars: number, max: number): string[] =>
  [...new Set([...values].map((value) => cut(value.trim(), maxChars)).filter((value) => value !== ''))].sort().slice(0, max);

/** Every entity of the tree (nested ones too), without recursion. */
function allEntities(roots: readonly SchemaEntity[]): SchemaEntity[] {
  const out: SchemaEntity[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const entity = stack.pop()!;
    out.push(entity);
    for (const property of entity.properties) for (let i = property.values.length - 1; i >= 0; i--) {
      const value = property.values[i]!;
      if (value.kind === 'entity') stack.push(value.entity);
    }
  }
  return out;
}

/** A JSON-LD block's canonical JSON, or `null` when it does not parse (or is too deep to write). */
function canonicalBlock(source: string): string | null {
  try {
    return canonicalJson(JSON.parse(source));
  } catch {
    return null;
  }
}

/** The structured data: every entity's types, and each JSON-LD block's types, hash and text. */
function structuredData(audit: SeoAudit): CaptureSnapshot['structuredData'] {
  const entities = allEntities(audit.schema.entities);
  const blocks: CaptureJsonLdBlock[] = audit.schema.blocks.slice(0, L.maxJsonLdBlocks).map((block) => {
    const json = block.status === 'valid' ? canonicalBlock(block.text) : null;
    const types = entities.filter((entity) => entity.block === block.index).flatMap((entity) => entity.types);
    return { types: sortedSet(types, L.maxTypeChars, L.maxTypes), hash: sha256Hex(json ?? block.text), text: cut(json ?? block.text, L.maxJsonLdBlockChars) };
  });
  return { types: sortedSet(entities.flatMap((entity) => entity.types), L.maxTypeChars, L.maxTypes), blocks };
}

/**
 * The snapshot of the page from its ready `audit` and the validated `regions` answer (each region's
 * `text` hashed with `hash`). Every value is cut to its cap; a snapshot whose canonical JSON is over
 * `MAX_SNAPSHOT_JSON_BYTES` keeps fewer links and blocks (`fitToStore`). The caller still parses it
 * with `CaptureSnapshotSchema` (a page that does not fit is `invalid-page`).
 */
export function buildCaptureSnapshot(audit: SeoAudit, regions: RegionAnswer, hash: (text: string) => string): CaptureSnapshot {
  const { page, indexability } = audit;
  // Only rules that read the page itself (`CAPTURE_EXCLUDED_RULES`): timing, the accessibility run and
  // the checks vary between loads of an unchanged page. The score is seo-core's, over those alone.
  const findings = audit.findings.filter((finding) => isCapturedRule(finding.ruleId));
  const status = indexability.http?.status;
  const xRobotsTag = indexability.xRobotsTag.map((tag) => tag.value).join(', ');
  const snapshot: CaptureSnapshot = {
    version: CAPTURE_SNAPSHOT_VERSION,
    url: storedPageUrl(audit.url) ?? audit.url,
    takenAt: safeCount(audit.takenAt),
    partial: page.partial || regions.partial,
    http: { status: Number.isInteger(status) && status! >= 100 && status! <= 999 ? status! : null, xRobotsTag: xRobotsTag === '' ? null : headText(xRobotsTag), indexable: audit.indexable },
    head: {
      title: headText(page.title?.text),
      metaDescription: headText(page.description?.text),
      canonical: urlText(page.canonical),
      robotsMeta: headText(page.robots),
      lang: headText(page.lang),
      viewport: headText(page.viewport),
      ogTitle: headText(page.social['og:title']),
      ogDescription: headText(page.social['og:description']),
      ogImage: urlText(page.social['og:image']),
      hreflang: indexability.hreflang.entries.slice(0, L.maxHreflang).map((entry) => ({ hreflang: text(entry.value, L.maxHeadChars), href: cut((entry.resolved ?? entry.href).trim(), L.maxUrlChars) })),
    },
    audit: {
      score: scoreAudit(findings),
      findings: sortedSet(
        findings.map((finding) => finding.ruleId),
        L.maxTypeChars,
        L.maxFindings,
      ),
    },
    structuredData: structuredData(audit),
    headings: regions.headings.slice(0, L.maxHeadings).map((heading) => ({ ...heading, text: cut(heading.text, L.maxHeadingChars) })),
    links: { ...regions.links, list: regions.links.list.slice(0, L.maxLinks) },
    images: { total: safeCount(page.images.total), missingAlt: safeCount(page.images.missingAlt) },
    regions: Object.fromEntries(
      PAGE_REGIONS.map((region) => {
        const { words, blocks, truncated, text: hashed } = regions.regions[region];
        return [region, { words, textHash: hash(hashed), blocks, truncated }];
      }),
    ) as CaptureSnapshot['regions'],
  };
  return fitToStore(snapshot);
}

/** Shrinking rounds `fitToStore` tries at most (each cuts one part to three quarters). */
const FIT_ROUNDS = 200;

type Part = 'links' | 'headings' | 'json-ld' | 'hreflang' | PageRegion;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const keep = (n: number) => Math.floor((n * 3) / 4);

/** `snapshot` with part `part` cut to three quarters (a region's blocks, or a list, or every JSON-LD block's text). */
function shrink(snapshot: CaptureSnapshot, part: Part): CaptureSnapshot {
  switch (part) {
    case 'links':
      return { ...snapshot, links: { ...snapshot.links, list: snapshot.links.list.slice(0, keep(snapshot.links.list.length)) } };
    case 'headings':
      return { ...snapshot, headings: snapshot.headings.slice(0, keep(snapshot.headings.length)) };
    case 'hreflang':
      return { ...snapshot, head: { ...snapshot.head, hreflang: snapshot.head.hreflang.slice(0, keep(snapshot.head.hreflang.length)) } };
    case 'json-ld':
      return { ...snapshot, structuredData: { ...snapshot.structuredData, blocks: snapshot.structuredData.blocks.map((block) => ({ ...block, text: cut(block.text, keep(block.text.length)) })) } };
    default: {
      const text = snapshot.regions[part];
      return { ...snapshot, regions: { ...snapshot.regions, [part]: { ...text, blocks: text.blocks.slice(0, keep(text.blocks.length)), truncated: true } } };
    }
  }
}

/**
 * `snapshot`, or a smaller one whose canonical JSON fits `MAX_SNAPSHOT_JSON_BYTES`: each round cuts
 * the largest part (a region's blocks, the link list, the headings, the JSON-LD texts or the
 * hreflang list) to three quarters. A region that loses blocks is `truncated` (its hash still covers
 * all its text), and the snapshot is `partial`.
 */
function fitToStore(snapshot: CaptureSnapshot): CaptureSnapshot {
  let current = snapshot;
  for (let round = 0; round < FIT_ROUNDS && Buffer.byteLength(canonicalJson(current), 'utf8') > MAX_SNAPSHOT_JSON_BYTES; round++) {
    const sizes: [Part, number][] = [
      ['links', bytes(current.links.list)],
      ['headings', bytes(current.headings)],
      ['json-ld', bytes(current.structuredData.blocks.map((block) => block.text))],
      ['hreflang', bytes(current.head.hreflang)],
      ...PAGE_REGIONS.map((region): [Part, number] => [region, bytes(current.regions[region].blocks)]),
    ];
    const [largest] = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
    current = { ...shrink(current, largest), partial: true };
  }
  return current;
}
