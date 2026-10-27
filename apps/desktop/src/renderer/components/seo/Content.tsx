import { useState } from 'react';
import { queryChecklist, type NgramRow, type SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import {
  CONTENT_LIMITS,
  NGRAM_PLACES,
  NGRAM_SIZES,
  READABILITY_UNAVAILABLE_MESSAGES,
  STOP_WORD_LANGUAGES,
  TARGET_QUERY_MAX_CHARS,
  TARGET_QUERY_PLACE_LABELS,
  type NgramPlace,
  type NgramSize,
  type QueryPresence,
} from '@app/specs/seo-content.spec';
import { capQuery, countLabel, ngramBar, ratio } from '../../content-view';
import { useContentNotes } from '../../hooks/useContentNotes';
import { CloseIcon } from '../../icons';
import { Flash, useFlash } from './actions';
import { AbsentGlyph, BarsIcon, BookIcon, PartialGlyph, PresentGlyph, TargetIcon } from './content-icons';
import { PageText, Section } from './parts';
import { SnippetEditor } from './SnippetEditor';

// Content (spec `seo-content.spec.ts`; acceptance `seo-content.feature.md`, Panel): the snippet
// preview and drafts, the target query checklist, the page's n-grams and its readability. All of
// it is information: nothing here is scored, and counts are never pass or fail. Page-derived text
// is React text only (`PageText`, `<bdi>`); bars are SVG attributes, never `style`.

const PLACE_SHORT: Readonly<Record<NgramPlace, [string, string]>> = {
  title: ['T', 'Title'],
  h1: ['H1', 'H1'],
  description: ['D', 'Meta description'],
  url: ['U', 'URL'],
};
const SIZE_LABEL: Readonly<Record<NgramSize, string>> = { 1: '1 word', 2: '2 words', 3: '3 words' };
const PRESENCE_LABEL: Readonly<Record<QueryPresence, string>> = { all: 'All terms', some: 'Some terms', none: 'No terms' };
const PRESENCE_GLYPH = { all: PresentGlyph, some: PartialGlyph, none: AbsentGlyph } as const;

function SectionTitle({ icon: Icon, text }: { readonly icon: typeof BookIcon; readonly text: string }) {
  return (
    <span className="seo-content-heading">
      <Icon />
      {text}
    </span>
  );
}

function TargetQuery({ audit, query, loaded, onChange }: { readonly audit: SeoAudit; readonly query: string; readonly loaded: boolean; readonly onChange: (query: string) => void }) {
  const checks = queryChecklist(query, audit.content.fields, audit.content.language.code);
  return (
    <div className="seo-query" data-testid="seo-query">
      <label className="seo-search seo-query-field">
        <TargetIcon />
        <input
          type="search"
          className="seo-search-input"
          data-testid="seo-query-input"
          placeholder="Type the query this page should answer"
          aria-label="Target query"
          value={query}
          maxLength={TARGET_QUERY_MAX_CHARS}
          disabled={!loaded}
          spellCheck={false}
          onChange={(event) => onChange(capQuery(event.target.value))}
        />
        {query !== '' ? (
          <button type="button" className="seo-query-clear" data-testid="seo-query-clear" aria-label="Clear the target query" onClick={() => onChange('')}>
            <CloseIcon />
          </button>
        ) : null}
      </label>
      {checks.length === 0 ? (
        <p className="seo-note">Where the query’s words appear on the page. Stored on this computer for this address only.</p>
      ) : (
        <>
          <ul className="seo-query-list" data-testid="seo-query-checklist">
            {checks.map((check) => {
              const Glyph = PRESENCE_GLYPH[check.presence];
              return (
                <li key={check.place} className="seo-query-row" data-testid="seo-query-place" data-place={check.place} data-presence={check.presence} data-phrase={check.phrase}>
                  <span className="seo-query-glyph" data-presence={check.presence} title={PRESENCE_LABEL[check.presence]}>
                    <Glyph />
                  </span>
                  <span className="seo-query-place">{TARGET_QUERY_PLACE_LABELS[check.place]}</span>
                  <span className="seo-query-terms">
                    {check.terms.map((term) => (
                      <span key={term.term} className="seo-query-term" data-present={term.present} title={term.present ? 'Present' : 'Not present'}>
                        <bdi dir="auto">{term.term}</bdi>
                      </span>
                    ))}
                    {check.phrase && check.terms.length > 1 ? <span className="seo-query-phrase">exact phrase</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="seo-note">A checklist, not a score: frost never rates a page on its keywords.</p>
        </>
      )}
    </div>
  );
}

function NgramTable({ rows, size }: { readonly rows: readonly NgramRow[]; readonly size: NgramSize }) {
  if (rows.length === 0) return <p className="seo-empty-line">{size === 1 ? 'No words to count on this page.' : `No ${SIZE_LABEL[size]} phrase appears twice.`}</p>;
  const max = rows[0]!.count;
  return (
    <ol className="seo-ngrams" data-testid="seo-ngrams" data-size={size}>
      {rows.map((row) => (
        <li key={row.text} className="seo-ngram" data-testid="seo-ngram">
          <PageText value={row.text} className="seo-ngram-text" testId="seo-ngram-text" />
          <span className="seo-ngram-count" data-testid="seo-ngram-count">
            {row.count.toLocaleString('en-US')}
          </span>
          <svg className="seo-ngram-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <rect className="seo-ngram-track" x="0" y="0" width="100" height="4" rx="2" />
            <rect className="seo-ngram-fill" x="0" y="0" width={ngramBar(row.count, max)} height="4" rx="2" />
          </svg>
          <span className="seo-ngram-places" aria-label={`In: ${NGRAM_PLACES.filter((p) => row.in[p]).map((p) => PLACE_SHORT[p][1]).join(', ') || 'none of title, H1, description, URL'}`}>
            {NGRAM_PLACES.map((place) => (
              <span key={place} className="seo-ngram-place" data-place={place} data-present={row.in[place]} title={`${row.in[place] ? 'In' : 'Not in'} the ${PLACE_SHORT[place][1]}`} aria-hidden="true">
                {PLACE_SHORT[place][0]}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Ngrams({ audit }: { readonly audit: SeoAudit }) {
  const [size, setSize] = useState<NgramSize>(1);
  const { content } = audit;
  const language = content.language;
  const languageLine =
    language.code === null
      ? 'Language unknown: no stop-words removed.'
      : `Language ${language.code} (${language.source})${language.stopWords ? ': common words removed.' : `: frost has no stop-word list for it (only ${STOP_WORD_LANGUAGES.join(', ')}), so common words are counted.`}`;
  return (
    <div className="seo-ngram-panel">
      <div className="seo-segmented" role="group" aria-label="Phrase length">
        {NGRAM_SIZES.map((n) => (
          <button key={n} type="button" className="seo-segment" data-testid="seo-ngram-size" data-size={n} aria-pressed={size === n} onClick={() => setSize(n)}>
            {SIZE_LABEL[n]}
            <span className="seo-segment-count">{content.ngrams[n].length}</span>
          </button>
        ))}
      </div>
      <div className="seo-ngram-legend" aria-hidden="true">
        {NGRAM_PLACES.map((place) => (
          <span key={place}>
            <span className="seo-ngram-place" data-present="true">
              {PLACE_SHORT[place][0]}
            </span>{' '}
            {PLACE_SHORT[place][1]}
          </span>
        ))}
      </div>
      <NgramTable rows={content.ngrams[size]} size={size} />
      <p className="seo-note" data-testid="seo-ngram-language">
        {languageLine}
      </p>
      <p className="seo-note">
        The {CONTENT_LIMITS.ngramRows} most frequent of {countLabel(content.words, 'word', 'words')} read{content.truncated ? ' (the page’s text was longer: counts are of the part read)' : ''}. Counts are information, not targets.
      </p>
    </div>
  );
}

function Readability({ audit }: { readonly audit: SeoAudit }) {
  const r = audit.content.readability;
  if (r.status !== 'ok') {
    return (
      <p className="seo-empty-line seo-readability-na" data-testid="seo-readability" data-status="not-available" data-reason={r.reason}>
        {READABILITY_UNAVAILABLE_MESSAGES[r.reason]}
      </p>
    );
  }
  const shown = Math.max(0, Math.min(100, r.score));
  return (
    <div className="seo-readability" data-testid="seo-readability" data-status="ok">
      <div className="seo-readability-score">
        <span className="seo-readability-value" data-testid="seo-readability-score">
          {r.score.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
        </span>
        <span className="seo-readability-band" data-testid="seo-readability-band">
          {r.band}
        </span>
      </div>
      <svg className="seo-readability-scale" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="seo-readability-track" x="0" y="2" width="100" height="4" rx="2" />
        <rect className="seo-readability-marker" x={Math.min(98.5, shown)} y="0" width="1.5" height="8" rx="0.75" />
      </svg>
      <div className="seo-readability-ends" aria-hidden="true">
        <span>Harder</span>
        <span>Easier</span>
      </div>
      <dl className="seo-readability-stats">
        <div>
          <dt>Words</dt>
          <dd>{r.words.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Words per sentence</dt>
          <dd>{ratio(r.words, r.sentences)}</dd>
        </div>
        <div>
          <dt>Syllables per word</dt>
          <dd>{ratio(r.syllables, r.words)}</dd>
        </div>
      </dl>
      <p className="seo-note">Flesch reading ease, for English text. Syllables are estimated by rule, so treat the score as a guide.</p>
    </div>
  );
}

export function Content({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [message, flash] = useFlash();
  const notes = useContentNotes(audit.url);
  return (
    <div className="seo-content" data-testid="seo-content">
      <Section title="Search preview" testId="seo-content-snippet">
        {/* Keyed by the page: a draft selected on one page is never shown against another. */}
        <SnippetEditor key={audit.url} audit={audit} tab={tab} notes={notes} flash={flash} />
      </Section>
      <Section title="Target query" testId="seo-content-query">
        <TargetQuery audit={audit} query={notes.query} loaded={notes.loaded} onChange={notes.setQuery} />
      </Section>
      <Section title="Frequent words and phrases" badge={<SectionTitle icon={BarsIcon} text="info only" />} testId="seo-content-ngrams">
        {audit.content.available ? <Ngrams audit={audit} /> : <p className="seo-empty-line">frost could not read this page’s text.</p>}
      </Section>
      <Section title="Readability" badge={<SectionTitle icon={BookIcon} text="Flesch" />} testId="seo-content-readability">
        <Readability audit={audit} />
      </Section>
      <Flash message={message} testId="seo-content-flash" />
    </div>
  );
}
