// Content analysis and snippet widths (Phase 2.5 Task 3; spec `specs/seo-content.spec.ts`).
export { contentReport, urlTerms, type ContentFields, type ContentReport } from './report';
export { ngramTables, type NgramFields, type NgramRow, type NgramTables } from './ngrams';
export { queryChecklist, queryTerms, type QueryPlaceCheck, type QueryTerms } from './query';
export { fleschBand, fleschReadingEase, readability, readabilityBand, syllables, type Readability } from './readability';
export { sentenceReport, type DifficultSentence, type SentenceReport } from './sentences';
export { SNIPPET_FONT_TABLE } from './snippet-font';
export { STOP_WORDS } from './stop-words';
export { escapeHtml, formatPx, measureSnippet, minSnippetWidth, snippetHtml, snippetText, textWidth, truncateToWidth, type SnippetCut, type SnippetMeasure } from './widths';
export { contentLanguage, fieldRuns, hasPhrase, hasSequence, isUnspaced, joinTerms, normaliseTerm, primaryLanguage, sentencesOf, stopWordsFor, wordRuns, wordsOf, type ContentLanguage, type Word } from './words';
// The result preview's facts and Copy JSON-LD (Phase 11 Task 3, Decision 4).
export {
  previewJsonLdBlocks,
  serpPreview,
  suggestedJsonLd,
  type SerpBreadcrumb,
  type SerpCrumb,
  type SerpDate,
  type SerpPreviewFacts,
  type SerpPreviewInput,
  type SerpPreviewOptions,
  type SerpRating,
  type SerpRecipe,
  type SerpSiteName,
  type SerpVideo,
  type SuggestedJsonLdFields,
} from './serp-preview';
