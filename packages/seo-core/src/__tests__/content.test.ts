// Spec: specs/seo-content.spec.ts (NGRAM_*, CONTENT_LIMITS, STOP_WORD_LANGUAGES, language detection,
// FLESCH, FLESCH_BANDS, READABILITY_FORMULAS, SENTENCE_LIMITS, the target query)
// Acceptance: specs/seo-content.feature.md (Words and n-grams, Readability, Sentences, Target query)
import { describe, expect, test } from 'vitest';
import { CONTENT_LIMITS, FLESCH, FLESCH_BANDS, INFLESZ_BANDS, NGRAM_SIZES, READABILITY_FORMULAS, READABILITY_LANGUAGES, SENTENCE_LIMITS, STOP_WORD_LANGUAGES, TARGET_QUERY_PLACES, VISIBLE_TEXT_LIMITS } from '@app/specs/seo-content.spec';
import { contentReport, fleschBand, fleschReadingEase, queryChecklist, queryTerms, readability, readabilityBand, runAudit, sentenceReport, STOP_WORDS, syllables, wordsOf, type ContentReport } from '../index';
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
    expect(easy).toEqual({ status: 'ok', formula: 'flesch', score: 116.1, band: 'Very easy', words: 120, sentences: 20, syllables: 120 });
    // A block boundary ends a sentence; digits are not words.
    const blocks = readability(Array.from({ length: 20 }, (_, i) => `Heading ${i}\nThe cat sat on the mat.`).join('\n'), 'en');
    expect(blocks.status === 'ok' && blocks.sentences).toBe(40);
  });

  test('syllable-heuristic-es', () => {
    const expected: Record<string, number> = {
      casa: 2,
      país: 2, // hiatus: two strong vowels
      leer: 2,
      aeropuerto: 5,
      ciudad: 2, // diphthong
      comunicación: 5,
      queso: 2, // silent u
      guerra: 2,
      pingüino: 3, // ü is sounded, and a weak vowel
      muy: 1, // final y is a vowel
      hoy: 1,
      yo: 1, // y before a vowel is not
      y: 1,
      '': 0,
      '123': 0,
    };
    for (const [word, count] of Object.entries(expected)) expect(syllables(word, 'es'), word).toBe(count);
  });

  test('syllable-heuristic-fr', () => {
    const expected: Record<string, number> = {
      le: 1, // the only vowel is not mute
      les: 1,
      table: 1, // mute final e
      femme: 1,
      belle: 1,
      maison: 2,
      beaucoup: 2,
      souvent: 2,
      université: 5,
      école: 2,
      aérer: 3, // a new syllable at é after a vowel
      haïr: 2,
      poème: 2,
      guerre: 1, // silent u
      "l'homme": 1,
      "aujourd'hui": 3,
      '': 0,
    };
    for (const [word, count] of Object.entries(expected)) expect(syllables(word, 'fr'), word).toBe(count);
  });

  test('syllable-heuristic-de', () => {
    const expected: Record<string, number> = {
      haus: 1,
      zeit: 1,
      boot: 1, // a long vowel written twice
      schule: 2, // a final e is counted
      zeitung: 2,
      theater: 3, // other vowel pairs are two
      qualität: 3, // silent u
      straße: 2,
      schön: 1,
      übung: 2,
      freundschaft: 2,
      bibliothek: 4,
      '': 0,
    };
    for (const [word, count] of Object.entries(expected)) expect(syllables(word, 'de'), word).toBe(count);
    expect(syllables('Straße', 'de')).toBe(2);
  });

  test('readability-formulas-per-language', () => {
    expect(READABILITY_LANGUAGES).toEqual(['en', 'es', 'fr', 'de']);
    expect(READABILITY_FORMULAS.en).toMatchObject({ id: 'flesch', base: FLESCH.base, wordsPerSentence: FLESCH.wordsPerSentence, syllablesPerWord: FLESCH.syllablesPerWord, bands: FLESCH_BANDS });
    expect(READABILITY_FORMULAS.es).toMatchObject({ id: 'szigriszt-pazos', base: 206.835, wordsPerSentence: 1, syllablesPerWord: 62.3 });
    expect(READABILITY_FORMULAS.fr).toMatchObject({ id: 'kandel-moles', base: 207, wordsPerSentence: 1.015, syllablesPerWord: 73.6 });
    expect(READABILITY_FORMULAS.de).toMatchObject({ id: 'amstad', base: 180, wordsPerSentence: 1, syllablesPerWord: 58.5 });
    const repeat = (sentence: string) => Array.from({ length: 20 }, () => sentence).join(' ');
    // 11 words and 27 syllables a sentence (el go-bier-no a-nun-ció hoy nue-vas me-di-das e-co-nó-mi-cas
    // pa-ra re-du-cir la in-fla-ción): 206.835 − 62.3 × 27/11 − 11 = 42.9.
    expect(readability(repeat('El gobierno anunció hoy nuevas medidas económicas para reducir la inflación.'), 'es')).toEqual({
      status: 'ok',
      formula: 'szigriszt-pazos',
      score: 42.9,
      band: 'Somewhat difficult',
      words: 220,
      sentences: 20,
      syllables: 540,
    });
    // 11 words and 24 syllables: 207 − 1.015 × 11 − 73.6 × 24/11 = 35.3.
    expect(readability(repeat("Le gouvernement a annoncé de nouvelles mesures économiques pour réduire l'inflation."), 'fr')).toEqual({
      status: 'ok',
      formula: 'kandel-moles',
      score: 35.3,
      band: 'Difficult',
      words: 220,
      sentences: 20,
      syllables: 480,
    });
    // 12 words and 28 syllables: 180 − 12 − 58.5 × 28/12 = 31.5.
    expect(readability(repeat('Die Regierung hat heute neue wirtschaftliche Maßnahmen zur Senkung der Inflation angekündigt.'), 'de')).toEqual({
      status: 'ok',
      formula: 'amstad',
      score: 31.5,
      band: 'Difficult',
      words: 240,
      sentences: 20,
      syllables: 560,
    });
    // Each language's bands: `min` is inclusive, the first match wins.
    expect(readabilityBand('es', 80)).toBe('Very easy');
    expect(readabilityBand('es', 79.9)).toBe('Quite easy');
    expect(readabilityBand('es', 65)).toBe('Quite easy');
    expect(readabilityBand('es', 64.9)).toBe('Normal');
    expect(readabilityBand('es', 55)).toBe('Normal');
    expect(readabilityBand('es', 54.9)).toBe('Somewhat difficult');
    expect(readabilityBand('es', 40)).toBe('Somewhat difficult');
    expect(readabilityBand('es', 39.9)).toBe('Very difficult');
    expect(INFLESZ_BANDS).toHaveLength(5);
    for (const language of ['fr', 'de'] as const) {
      expect(readabilityBand(language, 90)).toBe('Very easy');
      expect(readabilityBand(language, 30)).toBe('Difficult');
      expect(readabilityBand(language, 29.9)).toBe('Very difficult');
    }
    expect(readabilityBand('en', 60)).toBe('Plain English');
  });

  test('readability-not-available', () => {
    const italian = Array.from({ length: 30 }, () => 'Il gatto è sul tappeto.').join(' ');
    expect(readability(italian, 'it')).toEqual({ status: 'not-available', reason: 'language' });
    expect(readability(italian, null)).toEqual({ status: 'not-available', reason: 'language' });
    // The sentence statistics are still there for a language without a formula.
    expect(sentenceReport(italian, 'it')).toMatchObject({ status: 'ok', sentences: 30, averageWords: 5, longestWords: 5, longCount: 0, complexWordShare: null });
    expect(readability('The cat sat on the mat.', 'en')).toEqual({ status: 'not-available', reason: 'too-short' });
    expect(readability('  ', 'en')).toEqual({ status: 'not-available', reason: 'no-text' });
    expect(sentenceReport('  ', 'en')).toEqual({ status: 'not-available', reason: 'no-text' });
    expect(sentenceReport('12 34.', 'en')).toEqual({ status: 'not-available', reason: 'no-text' });
  });
});

describe('sentences', () => {
  /** A sentence of `n` one-syllable words (the first is `first`), ended by a full stop. */
  const sentence = (n: number, first = 'Cat') => `${[first, ...Array.from({ length: n - 1 }, () => 'cat')].join(' ')}.`;
  const BIG = 'abcdefghijklmno';

  test('sentence-stats', () => {
    const r = sentenceReport([4, 30, 10, 26].map((n) => sentence(n)).join(' '), 'en');
    expect(r).toMatchObject({ status: 'ok', sentences: 4, averageWords: 17.5, longestWords: 30, longCount: 2, complexWordShare: 0 });
    // The average is shown to one decimal; digits-only words and empty segments are not words.
    const odd = sentenceReport(`${sentence(3)} 2024.\n${sentence(4)}`, 'en');
    expect(odd).toMatchObject({ status: 'ok', sentences: 2, averageWords: 3.5, longestWords: 4 });
    expect(sentenceReport([5, 5, 6].map((n) => sentence(n)).join(' '), 'en')).toMatchObject({ averageWords: 5.3 });
    // The limit is exclusive: exactly 25 words is not long.
    expect(sentenceReport(sentence(SENTENCE_LIMITS.longSentenceWords), 'en')).toMatchObject({ longCount: 0 });
    expect(sentenceReport(sentence(SENTENCE_LIMITS.longSentenceWords + 1), 'en')).toMatchObject({ longCount: 1 });
  });

  test('difficult-sentences-long-and-complex', () => {
    const long = sentence(26);
    const dense = 'The administrative complications of international organizations unquestionably necessitated comprehensive reorganization immediately afterwards.';
    const shortDense = 'Notwithstanding administrative complications, international organizations necessitated reorganization.';
    const plain = 'The cat sat on the mat and the dog sat on it.';
    const longDense = `${Array.from({ length: 26 }, (_, i) => (i === 0 ? 'Ability' : 'ability')).join(' ')}.`;
    const r = sentenceReport([plain, long, shortDense, dense, longDense].join(' '), 'en');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Twelve plain words score far above 30; eight dense words are under the 12-word minimum.
    expect(r.difficult).toEqual({
      total: 3,
      items: [
        { text: long, words: 26, reason: 'long' },
        { text: dense, words: 12, reason: 'complex' },
        // Over 25 words is long, even when four-syllable words make it complex too.
        { text: longDense, words: 26, reason: 'long' },
      ],
    });
    // A language without a formula has long sentences only.
    const it = sentenceReport(`${Array.from({ length: 12 }, (_, i) => (i === 0 ? 'Internazionale' : 'internazionale')).join(' ')}. ${long}`, 'it');
    expect(it).toMatchObject({ status: 'ok', difficult: { total: 1, items: [{ text: long, words: 26, reason: 'long' }] } });
    // Spanish uses its own formula for the sentence: a dense Spanish sentence is complex.
    const es = 'Las responsabilidades administrativas de las organizaciones internacionales necesitaron reorganizaciones extraordinarias inmediatamente después de todo.';
    expect(sentenceReport(es, 'es')).toMatchObject({ difficult: { total: 1, items: [{ text: es, words: 14, reason: 'complex' }] } });
    expect(SENTENCE_LIMITS).toMatchObject({ longSentenceWords: 25, difficultSentenceMinWords: 12, difficultSentenceScore: 30 });
  });

  test('difficult-sentences-capped-and-in-page-order', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `n${i} ${Array.from({ length: 25 }, () => BIG).join(' ')}.`);
    const r = sentenceReport(sentences.join('\n'), 'en');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.difficult.total).toBe(30);
    expect(r.longCount).toBe(30);
    expect(r.difficult.items).toHaveLength(SENTENCE_LIMITS.maxDifficultSentences);
    // The first twenty, in page order; each cut to the limit but still counted whole.
    expect(r.difficult.items.map((item) => item.text.slice(0, 3).trim())).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`));
    for (const [i, item] of r.difficult.items.entries()) {
      expect(item.words).toBe(26);
      expect(item.text.length).toBeLessThanOrEqual(SENTENCE_LIMITS.maxSentenceExcerptChars);
      expect(sentences[i]!.startsWith(item.text)).toBe(true);
    }
    // A sentence is trimmed; a cut never splits a surrogate pair.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const words = (n: number, tail: string) => `${'aaaaaaaaa '.repeat(n)}${tail}`;
    const splitting = `${words(29, 'aaaaaaaa ')}😀 end.`; // the emoji starts at 299
    const fitting = `${words(29, 'aaaaaaa ')}😀 end.`; // the emoji ends at 300
    expect(splitting.indexOf('😀')).toBe(299);
    expect(fitting.indexOf('😀')).toBe(298);
    const cut = sentenceReport(`  ${splitting}  \n${fitting}`, 'en');
    expect(cut.status === 'ok' && cut.difficult.items.map((item) => item.text)).toEqual([splitting.slice(0, 299).trimEnd(), fitting.slice(0, 300)]);
    if (cut.status === 'ok') for (const item of cut.difficult.items) expect(item.text).not.toMatch(lone);
  });

  test('complex-word-share', () => {
    const en = sentenceReport('The cat sat. A beautiful university reorganization began.', 'en');
    expect(en).toMatchObject({ status: 'ok', complexWordShare: 0.375 });
    // A word of three syllables is complex; of two is not.
    expect(sentenceReport('Banana tomato sofa table.', 'en')).toMatchObject({ complexWordShare: 0.5 });
    // 3 of 7 (bonita, ciudadanos, celebraron); 1 of 6 (regardaient); 2 of 8 (Bibliothek, geöffnet).
    expect(sentenceReport('Una casa muy bonita. Los ciudadanos celebraron.', 'es')).toMatchObject({ complexWordShare: 0.429 });
    expect(sentenceReport('Une belle maison. Les enfants regardaient.', 'fr')).toMatchObject({ complexWordShare: 0.167 });
    expect(sentenceReport('Das ist ein Haus. Die Bibliothek ist geöffnet.', 'de')).toMatchObject({ complexWordShare: 0.25 });
    expect(sentenceReport('Una casa molto bella.', 'it')).toMatchObject({ complexWordShare: null });
    expect(sentenceReport('A beautiful university.', null)).toMatchObject({ complexWordShare: null });
    expect(SENTENCE_LIMITS.complexWordSyllables).toBe(3);
  });

  test('sentence-stats-cjk', () => {
    const ja = '私は毎日学校へ行きます。今日はとても良い天気です。';
    const r = sentenceReport(ja, 'ja');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.sentences).toBe(2);
    // Words are the segmenter's, not characters or white-space runs.
    const segmented = wordsOf(ja, 'ja').length;
    expect(segmented).toBeGreaterThan(2);
    expect(segmented).toBeLessThan([...ja].length);
    expect(r.averageWords).toBe(Math.round((segmented / 2) * 10) / 10);
    expect(r.complexWordShare).toBeNull();
    expect(readability(ja.repeat(20), 'ja')).toEqual({ status: 'not-available', reason: 'language' });
  });

  test('sentences-are-information', () => {
    const base = runAudit(cleanSnapshot());
    const dense = Array.from({ length: 40 }, () => 'The administrative complications of international organizations unquestionably necessitated comprehensive reorganization immediately afterwards.').join(' ');
    const stuffed = runAudit({ ...cleanSnapshot(), visibleText: { text: dense, truncated: false } });
    expect(stuffed.content.sentences).toMatchObject({ status: 'ok', sentences: 40, difficult: { total: 40 } });
    expect(base.content.sentences).toEqual({ status: 'not-available', reason: 'no-text' });
    expect(stuffed.findings).toEqual(base.findings);
    expect(stuffed.score).toBe(base.score);
  });

  test('sentence-report-stays-within-the-worker-budget', () => {
    // The longest text the extractor keeps: a hundred thousand characters of mixed sentences.
    const unit = 'The cat sat on the mat. An international organization necessitated comprehensive reorganization immediately afterwards, regardless of administrative complications. ';
    const big = unit.repeat(Math.ceil(VISIBLE_TEXT_LIMITS.maxVisibleTextChars / unit.length)).slice(0, VISIBLE_TEXT_LIMITS.maxVisibleTextChars);
    const started = performance.now();
    const r = sentenceReport(big, 'en');
    const ready = readability(big, 'en');
    const elapsed = performance.now() - started;
    expect(r.status).toBe('ok');
    expect(ready.status).toBe('ok');
    expect(elapsed).toBeLessThan(1_000);
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
