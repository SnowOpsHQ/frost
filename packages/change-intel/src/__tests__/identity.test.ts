// Spec: specs/capture.spec.ts (CaptureSnapshot, SnapshotDiff.partial)
// Acceptance: specs/changes-diff.feature.md (The snapshot: Identity; Partial snapshots)
import { expect, test } from 'vitest';
import { PAGE_REGIONS, type CaptureSnapshot, type PageRegion } from '@app/specs/capture.spec';
import { snapshotIdentityJson } from '../index';
import { base, diff, edited, region, seeded, sha, valid } from './fixtures';

/** The base page with more in it: duplicates, every region used, several JSON-LD blocks. */
function rich(): CaptureSnapshot {
  return edited((s) => {
    s.headings.push({ level: 2, text: 'Menu', region: 'nav' }, { level: 3, text: 'Related', region: 'aside' }, { level: 2, text: 'FAQ', region: 'main' });
    s.links.list.push(
      { href: 'https://example.com/', text: 'Logo', rel: '', region: 'header' },
      { href: 'https://example.com/', text: 'Home', rel: '', region: 'nav' },
      { href: 'https://example.com/blog', text: 'Blog', rel: '', region: 'aside' },
      { href: 'https://example.com/legal', text: 'Legal', rel: 'nofollow', region: 'other' },
    );
    s.head.hreflang.push({ hreflang: 'en', href: 'https://example.com/en/pricing' });
    s.structuredData.blocks.push({ types: ['Product'], hash: sha('product-b'), text: '{"@type":"Product","name":"Frost Team"}' });
    s.regions.aside = region(['Related reading', 'More guides']);
    s.regions.other = region(['Cookie notice']);
  });
}

type Mutation = (s: CaptureSnapshot, pick: <T>(list: readonly T[]) => T, random: () => number) => void;

const POOL = ['alpha', 'beta', 'gamma', 'delta'];
const swap = <T>(list: T[], i: number, j: number) => {
  if (list[i] === undefined || list[j] === undefined) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
};

/** Each keeps the snapshot schema-valid; many change only what the diff ignores. */
const MUTATIONS: Mutation[] = [
  (s, pick) => { s.head.title = pick(['Frost pricing', 'Pricing', null]); },
  (s, pick) => { s.head.ogDescription = pick([null, 'Shared']); },
  (s, pick) => { s.head.canonical = pick(['https://example.com/pricing', 'https://example.com/p', null]); },
  (s, _pick, random) => { s.head.hreflang.sort(() => random() - 0.5); },
  (s, pick) => { pick(s.head.hreflang).href = pick(['https://example.com/pricing', 'https://example.com/x']); },
  (s, pick) => { s.head.hreflang.push({ ...pick(s.head.hreflang) }); },
  (s) => { s.head.hreflang.pop(); },
  (s, pick) => { s.http.status = pick([200, 301, null]); },
  (s, pick) => { s.http.xRobotsTag = pick([null, 'noindex']); },
  (s) => { s.http.indexable = !s.http.indexable; },
  (s, pick) => { s.audit.score = pick([87, 50, 100]); },
  (s, pick) => { s.audit.findings = [...new Set([...s.audit.findings, pick(POOL)])].sort(); },
  (s) => { s.audit.findings = s.audit.findings.slice(1); },
  (s, pick) => { s.structuredData.types = [...new Set([...s.structuredData.types, pick(['FAQPage', 'Product'])])].sort(); },
  (s, _pick, random) => { s.structuredData.blocks.sort(() => random() - 0.5); },
  (s, pick) => { const block = pick(s.structuredData.blocks); if (block) { block.text = `${block.text} `; block.hash = sha(block.text); } },
  (s, pick) => { s.structuredData.blocks.push({ types: ['Product'], hash: sha(pick(POOL)), text: `{"name":"${pick(POOL)}"}` }); },
  (s) => { s.structuredData.blocks.shift(); },
  (s, pick) => { const h = pick(s.headings); if (h) h.text = pick(['Plans', 'FAQ', 'Prices']); },
  (s, pick) => { const h = pick(s.headings); if (h) h.level = pick([1, 2, 3]); },
  (s, pick) => { const h = pick(s.headings); if (h) h.region = pick(PAGE_REGIONS); },
  (s, _pick, random) => { const i = Math.floor(random() * s.headings.length); swap(s.headings, i, i + 1); },
  (s, pick) => { s.headings.splice(Math.floor(s.headings.length / 2), 0, { level: 2, text: pick(POOL), region: pick(PAGE_REGIONS) }); },
  (s, _pick, random) => { s.headings.splice(Math.floor(random() * s.headings.length), 1); },
  (s, _pick, random) => { s.links.list.sort(() => random() - 0.5); },
  (s, pick) => { const l = pick(s.links.list); if (l) l.text = pick(['Home', 'Logo', 'Docs']); },
  (s, pick) => { const l = pick(s.links.list); if (l) l.rel = pick(['', 'nofollow']); },
  (s, pick) => { const l = pick(s.links.list); if (l) l.region = pick(PAGE_REGIONS); },
  (s, pick) => { const l = pick(s.links.list); if (l) s.links.list.push({ ...l }); },
  (s, _pick, random) => { s.links.list.splice(Math.floor(random() * s.links.list.length), 1); },
  (s, pick) => { s.links.total = pick([5, 6, 9]); },
  (s, pick) => { s.images.missingAlt = pick([0, 1]); },
  (s, pick) => { const r = pick(PAGE_REGIONS); const blocks = [...s.regions[r].blocks]; blocks.splice(Math.floor(blocks.length / 2), 0, `${pick(POOL)} block`); s.regions[r] = { ...region(blocks), truncated: s.regions[r].truncated }; },
  (s, pick) => { const r = pick(PAGE_REGIONS); s.regions[r] = { ...region(s.regions[r].blocks.slice(0, -1)), truncated: s.regions[r].truncated }; },
  (s, pick) => { const r = pick(PAGE_REGIONS); const blocks = s.regions[r].blocks.map((b, i) => (i === 0 ? `${b} ${pick(POOL)}` : b)); s.regions[r] = { ...region(blocks), truncated: s.regions[r].truncated }; },
  (s, pick) => { const r = pick(PAGE_REGIONS); const blocks = [...s.regions[r].blocks].reverse(); s.regions[r] = { ...region(blocks), truncated: s.regions[r].truncated }; },
  (s, pick) => { s.regions[pick(PAGE_REGIONS)].textHash = sha(pick(POOL)); },
  (s, pick) => { s.regions[pick(PAGE_REGIONS)].words += 1; },
  (s, pick) => { const r: PageRegion = pick(PAGE_REGIONS); s.regions[r].truncated = !s.regions[r].truncated; },
  (s) => { s.partial = !s.partial; },
  (s) => { s.takenAt += 1_000; },
];

/** Whether `s` may lack items at its end (its diffs then decline to report those as removed). */
const cutShort = (s: CaptureSnapshot) => s.partial || PAGE_REGIONS.some((r) => s.regions[r].truncated);
const complete = (s: CaptureSnapshot) => !cutShort(s);

test('identity-and-diff-agree', () => {
  const random = seeded(2_026);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const mutate = (from: CaptureSnapshot, times: number) => edited((s) => {
    for (let i = 0; i < times; i++) pick(MUTATIONS)(s, pick, random);
  }, from);
  const seen = { equal: 0, different: 0, completeDifferent: 0, ignoredOnly: 0 };
  for (let round = 0; round < 600; round++) {
    const a = valid(mutate(rich(), Math.floor(random() * 3)));
    const b = valid(mutate(a, 1 + Math.floor(random() * 3)));
    const ids = [snapshotIdentityJson(a), snapshotIdentityJson(b)];
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const result = diff(from, to);
      const context = JSON.stringify({ round, from, to, changes: result.changes });
      if (ids[0] === ids[1]) {
        expect(result.changeCount, context).toBe(0);
        seen.equal++;
        if (JSON.stringify(from) !== JSON.stringify(to)) seen.ignoredOnly++;
        continue;
      }
      seen.different++;
      if (complete(from) && complete(to)) {
        seen.completeDifferent++;
        expect(result.changeCount, context).toBeGreaterThan(0);
      } else if (result.changeCount === 0) {
        // Only a new side that may have been cut short can hide a difference, and the diff says so.
        expect(cutShort(to), context).toBe(true);
        expect(result.partial, context).toBe(true);
      }
    }
  }
  // Both directions of the equivalence were exercised, also with differences the diff ignores.
  expect(seen.equal).toBeGreaterThan(50);
  expect(seen.ignoredOnly).toBeGreaterThan(20);
  expect(seen.completeDifferent).toBeGreaterThan(200);
}, 60_000);
