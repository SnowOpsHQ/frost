// Spec: specs/seo-content.spec.ts (NGRAM_*, CONTENT_LIMITS, STOP_WORD_LANGUAGES, language detection,
// FLESCH, FLESCH_BANDS, the target query)
// Acceptance: specs/seo-content.feature.md (Words and n-grams, Readability, Target query)
import { describe, expect, test } from 'vitest';
import { CONTENT_LIMITS, FLESCH_BANDS, NGRAM_SIZES, STOP_WORD_LANGUAGES, TARGET_QUERY_PLACES } from '@app/specs/seo-content.spec';
import { contentReport, fleschBand, fleschReadingEase, queryChecklist, queryTerms, readability, runAudit, STOP_WORDS, syllables, type ContentReport } from '../index';
import { cleanSnapshot, page, text } from './fixtures';

/** The content report of a page whose visible text is `body` (in `lang`). */
function report(body: string, changes: Parameters<typeof page>[0] = {}): ContentReport {
  return contentReport(page({ visibleText: { text: body, truncated: false }, ...changes }));
}

const texts = (r: ContentReport, size: 1 | 2 | 3) => r.ngrams[size].map((row) => row.text);
const counts = (r: ContentReport, size: 1 | 2 | 3) => Object.fromEntries(r.ngrams[size].map((row) => [row.text, row.count]));

describe('words and n-grams', () => {
  test('ngrams-latin', () => {
    const r = report(
      [
        'Search engine optimization helps pages rank. Search engine optimization takes time.',
        'Good search engine optimization starts with content: 2024 content wins.',
        'Optimization',
      ].join('\n'),
    );
    expect(counts(r, 1)).toMatchObject({ search: 3, engine: 3, optimization: 4, content: 2 });
    expect(texts(r, 1).slice(0, 4)).toEqual(['optimization', 'search', 'engine', 'content']);
    // Digits and stop-words are never a 1-gram.
    expect(texts(r, 1)).not.toContain('2024');
    expect(texts(r, 1)).not.toContain('with');
    expect(counts(r, 2)).toMatchObject({ 'search engine': 3, 'engine optimization': 3 });
    expect(counts(r, 3)).toEqual({ 'search engine optimization': 3 });
    // A 2-gram never spans punctuation ("content: 2024") or a line ("wins. / Optimization").
    expect(texts(r, 2)).not.toContain('content 2024');
    expect(texts(r, 2)).not.toContain('wins optimization');
    // Only n-grams seen at least twice are listed for 2 and 3 words.
    expect(r.ngrams[2].every((row) => row.count >= 2)).toBe(true);
    expect(r.words).toBe(22);
    for (const size of NGRAM_SIZES) expect(r.ngrams[size].length).toBeLessThanOrEqual(CONTENT_LIMITS.ngramRows);
  });

  test('ngrams-stop-words', () => {
    expect(STOP_WORD_LANGUAGES).toEqual(['en', 'es', 'fr', 'de']);
    for (const code of STOP_WORD_LANGUAGES) expect(STOP_WORDS[code].size).toBeGreaterThan(80);
    // A stop-word sits inside a 3-gram, never at its edge.
    const en = report('The state of play is good. The state of play changes. State of play.');
    expect(counts(en, 3)).toEqual({ 'state of play': 3 });
    expect(texts(en, 2)).toEqual([]);
    expect(en.language).toEqual({ code: 'en', source: 'declared', stopWords: true });
    const es = report('La optimización de la web es la clave. La optimización de la web ayuda.', { lang: 'es-ES' });
    expect(texts(es, 1)).not.toContain('la');
    expect(counts(es, 1)).toMatchObject({ optimización: 2, web: 2 });
    expect(es.language.code).toBe('es');
    const de = report('Die Suchmaschine und die Seite. Die Suchmaschine liest die Seite.', { lang: 'de' });
    expect(texts(de, 1)).toEqual(['suchmaschine', 'seite', 'liest']);
    const fr = report('Le moteur de recherche et le site. Le moteur de recherche lit le site.', { lang: 'fr' });
    expect(counts(fr, 3)).toEqual({ 'moteur de recherche': 2 });
    // A language without a list keeps its function words.
    const nl = report('De zoekmachine en de pagina. De zoekmachine leest de pagina.', { lang: 'nl' });
    expect(nl.language).toEqual({ code: 'nl', source: 'declared', stopWords: false });
    expect(counts(nl, 1)).toMatchObject({ de: 4 });
    // No lang: detected from stop-words when there is enough text, else unknown.
    const prose = Array.from({ length: 10 }, () => 'This is how the crawler reads the page and its links.').join(' ');
    expect(report(prose, { lang: null }).language).toEqual({ code: 'en', source: 'detected', stopWords: true });
    expect(report('Crawler links page.', { lang: null }).language).toEqual({ code: null, source: 'unknown', stopWords: false });
  });

  test('ngrams-cjk', () => {
    const zh = report('搜索引擎优化是一种提高网站排名的方法。搜索引擎优化很重要。', { lang: 'zh-CN' });
    expect(counts(zh, 1)).toMatchObject({ 搜索: 2, 引擎: 2 });
    // Words of scripts without spaces are joined without one.
    expect(counts(zh, 2)).toMatchObject({ 搜索引擎: 2 });
    const ja = report('検索エンジン最適化は重要です。検索エンジン最適化を学ぶ。', { lang: 'ja' });
    expect(counts(ja, 3)).toMatchObject({ 検索エンジン最適化: 2 });
    expect(ja.words).toBe(11);
  });

  test('ngrams-thai', () => {
    const th = report('เครื่องมือค้นหาอ่านเว็บไซต์ เครื่องมือค้นหาจัดอันดับเว็บไซต์', { lang: 'th' });
    // Segmented into words though written without spaces.
    expect(th.words).toBeGreaterThan(4);
    expect(counts(th, 1)['เว็บไซต์']).toBe(2);
    expect(texts(th, 1).every((word) => !word.includes(' '))).toBe(true);
  });

  test('ngram-presence', () => {
    const r = report('Green tea guide. Green tea is calm. Brewing green tea.', {
      url: 'https://example.com/guides/green-tea',
      titles: [text('Green tea: a practical guide for beginners')],
      headings: [{ level: 1, text: 'Brewing tea' }],
      metaDescriptions: [text('How to choose and brew green tea at home, step by step, for a calm cup.')],
    });
    const row = r.ngrams[2].find((n) => n.text === 'green tea')!;
    expect(row.in).toEqual({ title: true, h1: false, description: true, url: true });
    expect(r.ngrams[1].find((n) => n.text === 'brewing')!.in).toEqual({ title: false, h1: true, description: false, url: false });
    expect(r.ngrams[1].find((n) => n.text === 'tea')!.in).toEqual({ title: true, h1: true, description: true, url: true });
    // The URL's host and each path segment are runs of their own.
    expect(r.fields.url).toEqual([['example', 'com'], ['guides'], ['green', 'tea']]);
  });

  test('ngrams-are-information', () => {
    const base = runAudit(cleanSnapshot());
    const stuffed = runAudit({ ...cleanSnapshot(), visibleText: { text: Array.from({ length: 500 }, () => 'cheap tea').join(' '), truncated: false } });
    expect(stuffed.content.ngrams[2][0]).toMatchObject({ text: 'cheap tea', count: 500 });
    expect(stuffed.findings).toEqual(base.findings);
    expect(stuffed.score).toBe(base.score);
  });

  test('report-without-visible-text', () => {
    const r = contentReport(cleanSnapshot());
    expect(r.available).toBe(false);
    expect(r.words).toBe(0);
    expect(r.ngrams).toEqual({ 1: [], 2: [], 3: [] });
    expect(r.readability).toEqual({ status: 'not-available', reason: 'no-text' });
    // The snippet widths need no visible text.
    expect(r.snippet.title?.truncated).toBe(false);
  });
});

describe('review fixes', () => {
  test('phrases-stay-within-a-run', () => {
    const r = report('Foo bar baz. Foo bar baz.', {
      url: 'https://example.com/foo/bar-baz',
      titles: [text('Foo | Bar baz')],
      headings: [
        { level: 1, text: 'Foo' },
        { level: 1, text: 'Bar' },
        { level: 2, text: 'Baz qux' },
      ],
    });
    // Each place's runs end at punctuation and between elements.
    expect(r.fields.title).toEqual([['foo'], ['bar', 'baz']]);
    expect(r.fields.h1).toEqual([['foo'], ['bar']]);
    const by = Object.fromEntries(queryChecklist('foo bar', r.fields, 'en').map((c) => [c.place, c]));
    // Both words are there, but never as one phrase.
    expect(by['title']).toMatchObject({ presence: 'all', phrase: false });
    expect(by['h1']).toMatchObject({ presence: 'all', phrase: false });
    expect(by['url']).toMatchObject({ presence: 'all', phrase: false });
    expect(by['first-words']).toMatchObject({ presence: 'all', phrase: true });
    expect(queryChecklist('bar baz', r.fields, 'en').find((c) => c.place === 'url')).toMatchObject({ phrase: true });
    // n-gram rows are marked the same way.
    const fooBar = r.ngrams[2].find((row) => row.text === 'foo bar')!;
    expect(fooBar.in).toEqual({ title: false, h1: false, description: false, url: false });
    expect(r.ngrams[2].find((row) => row.text === 'bar baz')!.in).toMatchObject({ title: true, url: true });
  });

  test('case-folding-follows-the-language', () => {
    // Turkish, declared: İ → i and I → ı on both sides.
    const tr = report('İstanbul rehberi. İstanbul gezisi.', { lang: 'tr', titles: [text('İSTANBUL REHBERİ')], url: 'https://example.com/' });
    expect(texts(tr, 1)).toContain('istanbul');
    expect(tr.fields.title).toEqual([['istanbul', 'rehberi']]);
    expect(queryChecklist('istanbul', tr.fields, 'tr').find((c) => c.place === 'title')).toMatchObject({ presence: 'all' });
    expect(queryChecklist('İSTANBUL', tr.fields, 'tr').find((c) => c.place === 'title')).toMatchObject({ presence: 'all' });
    expect(queryTerms('ISPARTA', 'tr').terms).toEqual(['ısparta']);
    // Without a language, İ is still i (its combining dot above dropped).
    expect(queryTerms('İstanbul', null).terms).toEqual(['istanbul']);
    // ß is ss, so either spelling matches.
    const de = report('Die Straße am Fluss.', { lang: 'de', titles: [text('Die Strasse am Fluss')] });
    expect(texts(de, 1)).toContain('strasse');
    expect(queryChecklist('Straße', de.fields, 'de').find((c) => c.place === 'title')).toMatchObject({ presence: 'all', phrase: true });
  });

  test('long-words-are-capped', () => {
    const long = 'a'.repeat(200);
    const r = report(`${long} tea ${long} tea`, { titles: [text(long)] });
    expect(r.fields.title).toEqual([['a'.repeat(CONTENT_LIMITS.maxWordChars)]]);
    for (const size of NGRAM_SIZES) for (const row of r.ngrams[size]) for (const term of row.terms) expect([...term].length).toBeLessThanOrEqual(CONTENT_LIMITS.maxWordChars);
    expect(texts(r, 1)).toEqual(['tea']);
    expect(texts(r, 2)).toEqual([]);
  });
});

describe('readability', () => {
  test('syllable-heuristic', () => {
    const expected: Record<string, number> = {
      the: 1,
      cat: 1,
      table: 2,
      simple: 2,
      cake: 1,
      makes: 1,
      boxes: 2,
      pages: 2,
      wanted: 2,
      jumped: 1,
      readability: 5,
      yellow: 2,
      beautiful: 3,
      free: 1,
      optimization: 5,
      "don't": 1,
      '': 0,
    };
    for (const [word, count] of Object.entries(expected)) expect(syllables(word), word).toBe(count);
  });

  test('flesch-reading-ease', () => {
    expect(fleschReadingEase(100, 5, 150)).toBe(59.6);
    expect(fleschBand(59.6)).toBe('Fairly difficult');
    // Band edges: `min` is inclusive.
    expect(fleschBand(90)).toBe('Very easy');
    expect(fleschBand(89.9)).toBe('Easy');
    expect(fleschBand(30)).toBe('Difficult');
    expect(fleschBand(-12)).toBe('Very difficult');
    expect(FLESCH_BANDS.map((band) => band.label)).toHaveLength(7);
    // 20 sentences of six one-syllable words.
    const easy = readability(Array.from({ length: 20 }, () => 'The cat sat on the mat.').join(' '), 'en');
    expect(easy).toEqual({ status: 'ok', score: 116.1, band: 'Very easy', words: 120, sentences: 20, syllables: 120 });
    // A block boundary ends a sentence; digits are not words.
    const blocks = readability(Array.from({ length: 20 }, (_, i) => `Heading ${i}\nThe cat sat on the mat.`).join('\n'), 'en');
    expect(blocks.status === 'ok' && blocks.sentences).toBe(40);
  });

  test('readability-not-available', () => {
    const long = Array.from({ length: 30 }, () => 'Le chat est sur le tapis.').join(' ');
    expect(readability(long, 'fr')).toEqual({ status: 'not-available', reason: 'language' });
    expect(readability(long, null)).toEqual({ status: 'not-available', reason: 'language' });
    expect(readability('The cat sat on the mat.', 'en')).toEqual({ status: 'not-available', reason: 'too-short' });
    expect(readability('  ', 'en')).toEqual({ status: 'not-available', reason: 'no-text' });
  });
});

describe('target query', () => {
  test('query-terms', () => {
    expect(queryTerms('How to brew Green Tea', 'en')).toEqual({ terms: ['brew', 'green', 'tea'], phrase: ['how', 'to', 'brew', 'green', 'tea'] });
    // Only stop-words: they are the terms.
    expect(queryTerms('to be or not', 'en').terms).toEqual(['to', 'be', 'or', 'not']);
    expect(queryTerms('tea tea TEA', 'en').terms).toEqual(['tea']);
    expect(queryTerms(Array.from({ length: 20 }, (_, i) => `term${i}`).join(' '), 'en').terms).toHaveLength(CONTENT_LIMITS.maxQueryTerms);
    expect(queryTerms('  ', 'en').terms).toEqual([]);
  });

  test('query-checklist', () => {
    const r = report(`Green tea basics.\n${Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')} oolong`, {
      url: 'https://example.com/green-tea',
      titles: [text('Green tea: a practical guide')],
      headings: [
        { level: 1, text: 'Tea for beginners' },
        { level: 2, text: 'Brewing green tea' },
      ],
    });
    const checks = queryChecklist('green tea', r.fields, 'en');
    expect(checks.map((c) => c.place)).toEqual([...TARGET_QUERY_PLACES]);
    const by = Object.fromEntries(checks.map((c) => [c.place, c]));
    expect(by['title']).toMatchObject({ presence: 'all', phrase: true });
    expect(by['h1']).toMatchObject({ presence: 'some', phrase: false, terms: [{ term: 'green', present: false }, { term: 'tea', present: true }] });
    expect(by['url']).toMatchObject({ presence: 'all', phrase: true });
    expect(by['first-words']).toMatchObject({ presence: 'all', phrase: true });
    expect(by['headings']).toMatchObject({ presence: 'all', phrase: true });
    // A word past the first 100 is not in "first words".
    expect(queryChecklist('oolong', r.fields, 'en').find((c) => c.place === 'first-words')).toMatchObject({ presence: 'none' });
    expect(queryChecklist('', r.fields, 'en')).toEqual([]);
  });
});
