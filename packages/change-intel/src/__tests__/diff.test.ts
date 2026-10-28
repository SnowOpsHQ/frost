// Spec: specs/capture.spec.ts (DIFF_REGIONS, DIFF_FIELDS, DIFF_LIMITS, CAPTURE_LIMITS, the shapes)
// Acceptance: specs/changes-diff.feature.md (How each part is compared, Change order, Bounds and the fallback)
import { describe, expect, test } from 'vitest';
import { SnapshotDiffSchema } from '@app/specs/capture-snapshot.schema';
import { CAPTURE_LIMITS as L, DIFF_ENGINE_VERSION, DIFF_FIELDS, DIFF_LIMITS as D, DIFF_REGIONS, PAGE_REGIONS, type CaptureSnapshot, type Change, type DiffField, type DiffRegion } from '@app/specs/capture.spec';
import { diffSnapshots, EMPTY_CAPTURE_SNAPSHOT, type DiffProbe } from '../index';
import { base, diff, edited, LONG_INTRO, region, seeded, sha, valid } from './fixtures';

const of = (changes: Change[], field: DiffField) => changes.filter((change) => change.field === field);
const rebuild = (change: Change, side: 'before' | 'after') => change.segments!.filter((s) => s.op === 'same' || s.op === (side === 'before' ? 'del' : 'ins')).map((s) => s.text).join('');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The region every field's changes belong in, for the fields that are not page-region ones. */
const FIXED_REGION: Partial<Record<DiffField, DiffRegion>> = {
  title: 'head', 'meta-description': 'head', canonical: 'head', 'robots-meta': 'head', lang: 'head', viewport: 'head',
  'og-title': 'head', 'og-description': 'head', 'og-image': 'head', hreflang: 'head',
  status: 'http', 'x-robots-tag': 'http', indexable: 'http',
  score: 'audit', finding: 'audit', images: 'audit', 'links-total': 'audit',
  'structured-data-type': 'structured-data', 'structured-data-block': 'structured-data',
};

/** A page where every page region has a heading, a link and a block naming the region. */
function regional(tag: string): CaptureSnapshot {
  return edited((s) => {
    s.headings = PAGE_REGIONS.map((r) => ({ level: 2, text: `${r} heading ${tag}`, region: r }));
    s.links.list = PAGE_REGIONS.map((r) => ({ href: `https://example.com/${r}`, text: `${r} link ${tag}`, rel: '', region: r }));
    s.regions = Object.fromEntries(PAGE_REGIONS.map((r) => [r, region([`${r} words shared here`, `${r} text ${tag} ${tag === 'old' ? '' : 'and more words '}stays`])])) as CaptureSnapshot['regions'];
  });
}

describe('regions', () => {
  test('regions-tag-every-change', () => {
    const before = valid(regional('old'));
    const after = valid(
      edited((s) => {
        Object.assign(s.head, {
          title: 'New title', metaDescription: 'New description.', canonical: 'https://example.com/new', robotsMeta: 'noindex', lang: 'de',
          viewport: 'width=1024', ogTitle: null, ogDescription: 'Shared text', ogImage: 'https://example.com/og.png',
        });
        s.head.hreflang[1]!.href = 'https://example.com/de/neu';
        s.http = { status: 301, xRobotsTag: 'noindex', indexable: false };
        s.audit = { score: 40, findings: ['noindex', 'title-too-short'] };
        s.structuredData = { types: ['FAQPage', 'Organization'], blocks: [{ types: ['FAQPage'], hash: sha('faq'), text: '{"@type":"FAQPage"}' }, s.structuredData.blocks[0]!] };
        s.links.total = 9;
        s.images.missingAlt = 0;
        // `other` keeps its blocks; text past them changed (hash and word count only).
        s.regions.other = { ...before.regions.other, words: 99, textHash: sha('other, past the kept blocks') };
      }, regional('new')),
    );
    const { changes } = diff(before, after);
    expect(new Set(changes.map((c) => c.field))).toEqual(new Set(DIFF_FIELDS));
    for (const change of changes) {
      expect(DIFF_REGIONS).toContain(change.region);
      const fixed = FIXED_REGION[change.field];
      if (fixed) expect(change.region, change.field).toBe(fixed);
      else {
        expect(PAGE_REGIONS as readonly string[], change.field).toContain(change.region);
        if (change.field !== 'words' && change.field !== 'hidden-text') expect(`${change.before ?? ''} ${change.after ?? ''}`, JSON.stringify(change)).toContain(change.region);
      }
    }
    for (const r of PAGE_REGIONS) for (const field of ['heading', 'link', r === 'other' ? 'hidden-text' : 'text', 'words'] as const) expect(changes.some((c) => c.region === r && c.field === field), `${r} ${field}`).toBe(true);
    expect(of(changes, 'hidden-text')).toEqual([{ region: 'other', field: 'hidden-text', kind: 'changed', before: before.regions.other.textHash.slice(0, 12), after: after.regions.other.textHash.slice(0, 12), context: null }]);
  });
});

describe('equal and first versions', () => {
  test('unchanged-snapshots-diff-empty', () => {
    const zero = Object.fromEntries(DIFF_REGIONS.map((r) => [r, { added: 0, removed: 0, changed: 0 }]));
    expect(diff(base(), base())).toEqual({ engine: DIFF_ENGINE_VERSION, changes: [], summary: zero, changeCount: 0, truncated: false, partial: false });
    expect(diff(base(), edited((s) => { s.takenAt += 60_000; }))).toMatchObject({ changeCount: 0, partial: false });
    expect(diff(base(), edited((s) => { s.partial = true; }))).toEqual({ engine: DIFF_ENGINE_VERSION, changes: [], summary: zero, changeCount: 0, truncated: false, partial: true });
    expect(diff(edited((s) => { s.regions.nav.truncated = true; }), base())).toMatchObject({ changes: [], partial: true });
  });

  test('hidden-text-reports-changes-past-kept-blocks', () => {
    const after = edited((s) => {
      s.regions.main.textHash = sha('more text past the kept blocks');
    });
    expect(diff(base(), after).changes).toEqual([
      { region: 'main', field: 'hidden-text', kind: 'changed', before: base().regions.main.textHash.slice(0, 12), after: after.regions.main.textHash.slice(0, 12), context: null },
    ]);
    // A changed block explains the new hash: no hidden-text change.
    const edit = edited((s) => {
      s.regions.main = region([LONG_INTRO, 'Plans start at twelve dollars a month for one seat.', 'Contact us for team pricing.']);
    });
    expect(diff(base(), edit).changes.map((c) => c.field)).toEqual(['text']);
  });

  test('first-version-is-all-added', () => {
    const page = edited((s) => {
      s.http.indexable = false;
    });
    const first = diff(null, page);
    expect(first.changes.length).toBeGreaterThan(0);
    for (const change of first.changes) {
      expect(change.kind, JSON.stringify(change)).toBe('added');
      expect(change.before).toBeNull();
    }
    const changes = first.changes;
    expect(of(changes, 'heading')).toHaveLength(page.headings.length);
    expect(of(changes, 'link')).toHaveLength(page.links.list.length);
    expect(of(changes, 'text')).toHaveLength(PAGE_REGIONS.reduce((sum, r) => sum + page.regions[r].blocks.length, 0));
    expect(of(changes, 'finding').map((c) => c.after)).toEqual(page.audit.findings);
    expect(of(changes, 'structured-data-type').map((c) => c.after)).toEqual(page.structuredData.types);
    expect(of(changes, 'structured-data-block')).toHaveLength(page.structuredData.blocks.length);
    expect(of(changes, 'indexable')).toEqual([{ region: 'http', field: 'indexable', kind: 'added', before: null, after: 'false', context: null }]);
    expect(of(changes, 'score')[0]?.after).toBe('87');
    expect(of(changes, 'og-description')).toEqual([]); // null on both sides
    expect(first.summary.audit.added).toBe(of(changes, 'finding').length + 1 + of(changes, 'links-total').length + of(changes, 'images').length);
    // Against the empty snapshot explicitly: the same items; the scalars compare with its values.
    const scalars = ['indexable', 'score', 'links-total', 'images', 'words'];
    const fromEmpty = diff(EMPTY_CAPTURE_SNAPSHOT, page);
    expect(fromEmpty.changes.filter((c) => !scalars.includes(c.field))).toEqual(first.changes.filter((c) => !scalars.includes(c.field)));
    expect(fromEmpty.changes.filter((c) => scalars.includes(c.field)).map((c) => [c.region, c.field, c.kind, c.before, c.after, c.context])).toEqual([
      ['main', 'words', 'changed', '0', String(page.regions.main.words), null],
      ['nav', 'words', 'changed', '0', '2', null],
      ['header', 'words', 'changed', '0', '1', null],
      ['footer', 'words', 'changed', '0', '2', null],
      ['audit', 'score', 'changed', '0', '87', null],
      ['audit', 'images', 'changed', '0', '3', 'total'],
      ['audit', 'images', 'changed', '0', '1', 'missing-alt'],
      ['audit', 'links-total', 'changed', '0', '5', 'total'],
      ['audit', 'links-total', 'changed', '0', '4', 'internal'],
      ['audit', 'links-total', 'changed', '0', '1', 'external'],
      ['audit', 'links-total', 'changed', '0', '1', 'nofollow'],
    ]); // indexable is false on both sides: no change
  });
});

/** `value` with the keys of every object in reverse order (same entries). */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)])) as T;
  return value;
}

describe('determinism', () => {
  test('diff-is-deterministic', () => {
    const before = regional('old');
    const after = edited((s) => {
      s.head.title = 'Other';
      s.audit.findings = ['a-rule'];
    }, regional('new'));
    const first = diff(before, after);
    expect(diff(before, after)).toEqual(first);
    expect(diff(reversedKeys(before), reversedKeys(after))).toEqual(first);
    expect(JSON.stringify(diff(reversedKeys(before), reversedKeys(after)))).toBe(JSON.stringify(first));
    // Region order, then field order.
    const rank = first.changes.map((c) => DIFF_REGIONS.indexOf(c.region) * 100 + DIFF_FIELDS.indexOf(c.field));
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
  });
});

/** `n` distinct words, unlike any other seed's. */
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i.toString(36)}`);
const pad = (text: string, length: number) => (text + ' ' + 'x'.repeat(length)).slice(0, length);

/** A snapshot at every cap; `seed` makes all its text unlike another seed's. */
function atCaps(seed: string, blocksPerRegion = L.maxBlocksPerRegion, blockChars = Math.floor(L.maxRegionChars / L.maxBlocksPerRegion)): CaptureSnapshot {
  const types = Array.from({ length: L.maxTypes }, (_, i) => pad(`${seed}Type${i.toString().padStart(3, '0')}`, L.maxTypeChars)).sort();
  return {
    ...base(),
    head: {
      ...base().head,
      title: pad(`${seed} title`, L.maxHeadChars),
      metaDescription: pad(`${seed} description`, L.maxHeadChars),
      hreflang: Array.from({ length: L.maxHreflang }, (_, i) => ({ hreflang: `x${i}`, href: pad(`https://example.com/${seed}/${i}/`, L.maxUrlChars) })),
    },
    audit: { score: seed.length % 100, findings: Array.from({ length: L.maxFindings }, (_, i) => `${seed}-rule-${i.toString().padStart(3, '0')}`).sort() },
    structuredData: {
      types,
      blocks: Array.from({ length: L.maxJsonLdBlocks }, (_, i) => ({ types: types.slice(i, i + 5), hash: sha(`${seed}${i}`), text: pad(`{"${seed}":${i}`, L.maxJsonLdBlockChars) })),
    },
    headings: Array.from({ length: L.maxHeadings }, (_, i) => ({ level: (i % 6) + 1, text: pad(`${seed} heading ${i}`, L.maxHeadingChars), region: PAGE_REGIONS[i % 6]! })),
    links: {
      total: 10_000,
      internal: 9_000,
      external: 1_000,
      nofollow: 10,
      list: Array.from({ length: L.maxLinks }, (_, i) => ({ href: pad(`https://example.com/${seed}/${i}?`, L.maxUrlChars), text: pad(`${seed} link ${i}`, L.maxAnchorChars), rel: '', region: PAGE_REGIONS[i % 6]! })),
    },
    regions: Object.fromEntries(PAGE_REGIONS.map((r) => [r, region(Array.from({ length: blocksPerRegion }, (_, i) => words(`${seed}${r}${i}w`, 400).join(' ').slice(0, blockChars).trim()))])) as CaptureSnapshot['regions'],
  };
}

const timed = <T>(run: () => T): [T, number] => {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
};

describe('bounds', () => {
  test('diff-work-is-bounded', () => {
    // Every list and string at its cap, nothing in common.
    const before = valid(atCaps('a'));
    const after = valid(atCaps('b'));
    diffSnapshots(before, after); // warm up the JIT once
    const probe: DiffProbe = { work: 0, fallbacks: [] };
    const [result, ms] = timed(() => diffSnapshots(before, after, probe));
    expect(ms).toBeLessThan(250);
    expect(result.changes).toHaveLength(D.maxChanges);
    expect(result.truncated).toBe(true);
    expect(result.changeCount).toBeGreaterThan(D.maxChanges);
    expect(Object.values(result.summary).reduce((sum, c) => sum + c.added + c.removed + c.changed, 0)).toBe(result.changeCount);
    diff(before, after);

    // Every block shares 20 words with every other, yet no two are similar enough (Jaccard 20/70):
    // pairing visits the most postings it can, and its cap stops it.
    const common = Array.from({ length: 20 }, (_, i) => `c${i}`);
    let unique = 0;
    const shared = () => edited((s) => {
      s.regions = Object.fromEntries(PAGE_REGIONS.map((r) => [r, region(Array.from({ length: L.maxBlocksPerRegion }, () => [...common, ...Array.from({ length: 25 }, () => (unique++).toString(36))].join(' ')))])) as CaptureSnapshot['regions'];
    });
    const [sharedBefore, sharedAfter] = [valid(shared()), valid(shared())];
    const sharedProbe: DiffProbe = { work: 0, fallbacks: [] };
    const [sharedResult, sharedMs] = timed(() => diffSnapshots(sharedBefore, sharedAfter, sharedProbe));
    expect(sharedMs).toBeLessThan(250);
    expect(sharedProbe.fallbacks).toContain('pairing:main');
    expect(SnapshotDiffSchema.safeParse(sharedResult).success).toBe(true);

    // Lists past the caps (a corrupt or future snapshot): one LCS would be 1 000 × 1 000 cells.
    const big = (seed: string) => edited((s) => {
      s.regions.main = region(words(`${seed}big`, 1_000));
    });
    const bigProbe: DiffProbe = { work: 0, fallbacks: [] };
    const [bigResult, bigMs] = timed(() => diffSnapshots(big('a'), big('b'), bigProbe));
    expect(bigMs).toBeLessThan(250);
    expect(bigProbe.fallbacks).toContain('text:main');
    expect(bigResult.summary.main).toEqual({ added: 1_000, removed: 1_000, changed: 0 });
    expect(SnapshotDiffSchema.safeParse(bigResult).success).toBe(true);

    // Every block of every region edited (so every block pairs and wants an inline diff).
    const near = (seed: string) => edited((s) => {
      s.regions = Object.fromEntries(PAGE_REGIONS.map((r) => [r, region(Array.from({ length: L.maxBlocksPerRegion }, (_, i) => { const w = words(`${r}${i}w`, 15); w[i % 15] = `${seed}edit`; return w.reverse().join(' '); }))])) as CaptureSnapshot['regions'];
    });
    const nearProbe: DiffProbe = { work: 0, fallbacks: [] };
    const [nearResult, nearMs] = timed(() => diffSnapshots(valid(near('a')), valid(near('b')), nearProbe));
    expect(nearMs).toBeLessThan(250);
    expect(nearProbe.fallbacks).toEqual([]);
    for (const r of PAGE_REGIONS) expect(nearResult.summary[r]).toEqual({ added: 0, removed: 0, changed: L.maxBlocksPerRegion });
    expect(nearResult.changes.every((c) => c.field === 'text' && c.kind === 'changed' && c.segments)).toBe(true);
    expect(SnapshotDiffSchema.safeParse(nearResult).success).toBe(true);
  });

  test('pairing-survives-unrelated-blocks', () => {
    // 25 paragraphs deleted, then 35 paragraphs of ~165 words with one word each changed.
    const random = seeded(7);
    const common = ['the', 'of', 'and', 'to', 'in', 'is', 'for', 'on', 'with', 'as', 'by', 'at', 'it', 'from', 'that', 'this', 'are', 'be', 'or', 'an'];
    const word = () => (random() < 0.15 ? common[Math.floor(random() * common.length)]! : Array.from({ length: 3 + Math.floor(random() * 4) }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 26)]).join(''));
    const paragraph = () => Array.from({ length: 165 }, word);
    const deleted = Array.from({ length: 25 }, () => paragraph().join(' '));
    const kept = Array.from({ length: 35 }, paragraph);
    const edits = kept.map((words, i) => words.map((w, k) => (k === 80 ? `edited${i}` : w)).join(' '));
    const before = edited((s) => { s.regions.main = region([...deleted, ...kept.map((w) => w.join(' '))]); });
    const after = edited((s) => { s.regions.main = region(edits); });
    const probe: DiffProbe = { work: 0, fallbacks: [] };
    const result = diff(before, after, probe);
    expect(probe.fallbacks).toEqual([]);
    const text = of(result.changes, 'text');
    expect(text.filter((c) => c.kind === 'removed').map((c) => c.before)).toEqual(deleted);
    expect(text.filter((c) => c.kind === 'changed')).toHaveLength(35);
    expect(text.filter((c) => c.kind === 'added')).toEqual([]);
    for (const change of text.filter((c) => c.kind === 'changed')) expect(change.segments?.filter((s) => s.op !== 'same')).toHaveLength(2);
  });

  test('truncated-side-reports-no-false-removals', () => {
    const blocks = Array.from({ length: L.maxBlocksPerRegion }, (_, i) => `Paragraph ${i} of a long page.`);
    const full = (list: string[], truncated: boolean) => edited((s) => { s.regions.main = { ...region(list), truncated }; });
    const inserted = ['A new opening paragraph.', ...blocks.slice(0, -1)];
    // The new side is at its cap: the last old paragraph was pushed out, not removed.
    const cutShort = diff(full(blocks, true), full(inserted, true));
    expect(of(cutShort.changes, 'text')).toEqual([{ region: 'main', field: 'text', kind: 'added', before: null, after: 'A new opening paragraph.', context: null }]);
    expect(cutShort.partial).toBe(true);
    // A complete new side really lost it.
    const complete = diff(full(blocks, false), full(inserted, false));
    expect(of(complete.changes, 'text').map((c) => [c.kind, c.before ?? c.after])).toEqual([['added', 'A new opening paragraph.'], ['removed', blocks.at(-1)]]);
    expect(complete.partial).toBe(false);
    // A partial snapshot cuts headings and links the same way.
    const partial = diff(base(), edited((s) => {
      s.partial = true;
      s.headings = s.headings.filter((h) => h.text !== 'FAQ');
      s.links.list = s.links.list.filter((l) => l.text !== 'Docs');
    }));
    expect(partial.changes.filter((c) => c.field === 'heading' || c.field === 'link')).toEqual([]);
    // ... but not what it lacks before its last kept item.
    const middle = diff(base(), edited((s) => {
      s.partial = true;
      s.headings = s.headings.filter((h) => h.text !== 'Plans');
    }));
    expect(of(middle.changes, 'heading')).toEqual([{ region: 'main', field: 'heading', kind: 'removed', before: 'Plans', after: null, context: 'h2' }]);
  });
});

describe('text blocks', () => {
  test('text-edit-is-a-change-with-segments', () => {
    const after = edited((s) => {
      s.regions.main = region([LONG_INTRO, 'Plans start at twelve dollars a month for one seat.', 'Contact us for team pricing.']);
    });
    const { changes } = diff(base(), after);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change).toMatchObject({ region: 'main', field: 'text', kind: 'changed', before: 'Plans start at ten dollars a month for one seat.', after: 'Plans start at twelve dollars a month for one seat.' });
    expect(change.context).toBe(`${LONG_INTRO.slice(0, D.contextChars - 1)}…`);
    expect(change.context).toHaveLength(D.contextChars);
    expect(change.segments).toEqual([
      { op: 'same', text: 'Plans start at ' },
      { op: 'del', text: 'ten' },
      { op: 'ins', text: 'twelve' },
      { op: 'same', text: ' dollars a month for one seat.' },
    ]);
    expect(rebuild(change, 'before')).toBe(change.before);
    expect(rebuild(change, 'after')).toBe(change.after);
    // At the start of a region there is no context.
    const first = diff(base(), edited((s) => { s.regions.main.blocks[0] = LONG_INTRO.replace('browser', 'tool'); })).changes[0]!;
    expect(first).toMatchObject({ kind: 'changed', context: null });
  });

  test('unrelated-text-is-remove-plus-add', () => {
    const after = edited((s) => {
      s.regions.main = region([LONG_INTRO, 'Our offices are closed on public holidays across Europe.', 'Contact us for team pricing.']);
    });
    const { changes } = diff(base(), after);
    expect(changes.map((c) => [c.field, c.kind])).toEqual([['text', 'removed'], ['text', 'added'], ['words', 'changed']]);
    expect(changes[0]).toEqual({ region: 'main', field: 'text', kind: 'removed', before: 'Plans start at ten dollars a month for one seat.', after: null, context: `${LONG_INTRO.slice(0, D.contextChars - 1)}…` });
    expect(changes[1]?.segments).toBeUndefined();
    expect(changes[2]).toEqual({ region: 'main', field: 'words', kind: 'changed', before: String(base().regions.main.words), after: String(after.regions.main.words), context: null });
  });
});

describe('headings and links', () => {
  test('heading-and-link-moves', () => {
    const after = edited((s) => {
      s.headings = [s.headings[0]!, s.headings[2]!, s.headings[1]!, s.headings[3]!]; // FAQ before Plans
      s.links.list = [s.links.list[1]!, s.links.list[0]!, s.links.list[3]!, s.links.list[2]!]; // nav reordered
      s.links.list[2] = { ...s.links.list[2]!, region: 'nav' }; // the partner link moves to nav
    });
    const { changes } = diff(base(), after);
    const headings = of(changes, 'heading');
    expect(headings.map((c) => c.kind)).toEqual(['removed', 'added']);
    expect(headings[0]!.before).toBe(headings[1]!.after);
    expect(headings.every((c) => c.region === 'main' && c.context === 'h2')).toBe(true);
    expect(of(changes, 'link')).toEqual([
      { region: 'nav', field: 'link', kind: 'added', before: null, after: 'Partner (rel=nofollow)', context: 'https://partner.example/' },
      { region: 'footer', field: 'link', kind: 'removed', before: 'Partner (rel=nofollow)', after: null, context: 'https://partner.example/' },
    ]);
    // Retitled at the same level and place: one changed heading.
    const retitled = diff(base(), edited((s) => { s.headings[2]!.text = 'Questions'; })).changes;
    expect(retitled).toEqual([{ region: 'main', field: 'heading', kind: 'changed', before: 'FAQ', after: 'Questions', context: 'h2' }]);
    // A different level is not the same heading.
    const relevelled = diff(base(), edited((s) => { s.headings[2] = { level: 3, text: 'Questions', region: 'main' }; })).changes;
    expect(relevelled.map((c) => c.kind)).toEqual(['removed', 'added']);
  });

  test('link-text-change-is-changed', () => {
    const after = edited((s) => {
      s.links.list[1]!.text = 'Documentation';
      s.links.list[3]!.rel = '';
    });
    expect(of(diff(base(), after).changes, 'link')).toEqual([
      { region: 'nav', field: 'link', kind: 'changed', before: 'Docs', after: 'Documentation', context: 'https://example.com/docs' },
      { region: 'footer', field: 'link', kind: 'changed', before: 'Partner (rel=nofollow)', after: 'Partner', context: 'https://partner.example/' },
    ]);
  });
});

describe('duplicate keys', () => {
  test('duplicate-keys-match-exact-items-first', () => {
    const links = (list: [string, string][]) => edited((s) => { s.links.list = list.map(([href, text]) => ({ href, text, rel: '', region: 'nav' })); });
    expect(of(diff(links([['https://example.com/', 'Home'], ['https://example.com/', 'Logo']]), links([['https://example.com/', 'Logo']])).changes, 'link')).toEqual([
      { region: 'nav', field: 'link', kind: 'removed', before: 'Home', after: null, context: 'https://example.com/' },
    ]);
    expect(diff(links([['https://example.com/', 'Home'], ['https://example.com/', 'Logo']]), links([['https://example.com/', 'Logo'], ['https://example.com/', 'Home']])).changes).toEqual([]);
    const alternates = (list: [string, string][]) => edited((s) => { s.head.hreflang = list.map(([hreflang, href]) => ({ hreflang, href })); });
    expect(of(diff(alternates([['en', 'https://example.com/a'], ['en', 'https://example.com/b']]), alternates([['en', 'https://example.com/b']])).changes, 'hreflang')).toEqual([
      { region: 'head', field: 'hreflang', kind: 'removed', before: 'https://example.com/a', after: null, context: 'en' },
    ]);
    const product = (name: string) => ({ types: ['Product'], hash: sha(name), text: `{"@type":"Product","name":"${name}"}` });
    const blocks = (names: string[]) => edited((s) => { s.structuredData = { types: ['Product'], blocks: names.map(product) }; });
    expect(diff(blocks(['Alpha', 'Beta']), blocks(['Beta v2'])).changes).toEqual([
      { region: 'structured-data', field: 'structured-data-block', kind: 'changed', before: product('Beta').text, after: product('Beta v2').text, context: 'Product' },
      { region: 'structured-data', field: 'structured-data-block', kind: 'removed', before: product('Alpha').text, after: null, context: 'Product' },
    ]);
  });
});

describe('structured data, audit and totals', () => {
  test('structured-data-type-changes', () => {
    const after = edited((s) => {
      s.structuredData = {
        types: ['FAQPage', 'Product'],
        blocks: [
          { types: ['Product'], hash: sha('product-2'), text: '{"@type":"Product","name":"Frost Pro","offers":{"price":"12"}}' },
          { types: ['FAQPage'], hash: sha('faq'), text: '{"@type":"FAQPage"}' },
        ],
      };
    });
    const changes = diff(base(), after).changes.filter((c) => c.region === 'structured-data');
    expect(changes).toEqual([
      { region: 'structured-data', field: 'structured-data-type', kind: 'added', before: null, after: 'FAQPage', context: null },
      { region: 'structured-data', field: 'structured-data-type', kind: 'removed', before: 'Organization', after: null, context: null },
      { region: 'structured-data', field: 'structured-data-block', kind: 'changed', before: base().structuredData.blocks[1]!.text, after: after.structuredData.blocks[0]!.text, context: 'Product' },
      { region: 'structured-data', field: 'structured-data-block', kind: 'added', before: null, after: '{"@type":"FAQPage"}', context: 'FAQPage' },
      { region: 'structured-data', field: 'structured-data-block', kind: 'removed', before: base().structuredData.blocks[0]!.text, after: null, context: 'Organization' },
    ]);
    // Same hash, other position: unchanged.
    expect(diff(base(), edited((s) => { s.structuredData.blocks.reverse(); })).changes).toEqual([]);
  });

  test('findings-are-audit-changes', () => {
    const after = edited((s) => {
      s.audit = { score: 70, findings: ['canonical-missing', 'meta-description-too-short'] };
      s.links.total = 6;
      s.links.nofollow = 0;
      s.images.missingAlt = 0;
    });
    expect(diff(base(), after).changes).toEqual([
      { region: 'audit', field: 'score', kind: 'changed', before: '87', after: '70', context: null },
      { region: 'audit', field: 'finding', kind: 'added', before: null, after: 'canonical-missing', context: null },
      { region: 'audit', field: 'finding', kind: 'removed', before: 'title-too-short', after: null, context: null },
      { region: 'audit', field: 'images', kind: 'changed', before: '1', after: '0', context: 'missing-alt' },
      { region: 'audit', field: 'links-total', kind: 'changed', before: '5', after: '6', context: 'total' },
      { region: 'audit', field: 'links-total', kind: 'changed', before: '1', after: '0', context: 'nofollow' },
    ]);
  });

  test('change-text-is-capped', () => {
    const long = (fill: string) => `${'a'.repeat(D.maxChangeTextChars - 2)}😀${fill.repeat(L.maxJsonLdBlockChars)}`.slice(0, L.maxJsonLdBlockChars);
    const after = edited((s) => {
      s.structuredData.blocks[1] = { types: ['Product'], hash: sha('long'), text: long('b') };
    });
    const before = edited((s) => {
      s.structuredData.blocks[1] = { types: ['Product'], hash: sha('long-before'), text: long('c') };
    });
    const [change] = diff(before, after).changes;
    expect(change).toMatchObject({ field: 'structured-data-block', kind: 'changed' });
    for (const text of [change!.before!, change!.after!]) {
      expect(text.length).toBeLessThanOrEqual(D.maxChangeTextChars);
      expect(text.endsWith('…')).toBe(true);
      expect(text).not.toMatch(LONE_SURROGATE);
      expect(text).toBe(`${'a'.repeat(D.maxChangeTextChars - 2)}…`);
    }
    // A cut that falls after the pair keeps it whole.
    const kept = diff(null, edited((s) => { s.head.title = `${'a'.repeat(D.maxChangeTextChars - 3)}😀${'b'.repeat(10)}`; }, before)).changes.find((c) => c.field === 'title')!;
    expect(kept.after).toBe(`${'a'.repeat(D.maxChangeTextChars - 3)}😀…`);
  });
});
