// Content analysis and snippet widths (Phase 2.5 Task 3; spec `specs/seo-content.spec.ts`).
export { contentReport, urlTerms, type ContentFields, type ContentReport } from './report';
export { ngramTables, type NgramFields, type NgramRow, type NgramTables } from './ngrams';
export { queryChecklist, queryTerms, type QueryPlaceCheck, type QueryTerms } from './query';
export { fleschBand, fleschReadingEase, readability, syllables, type Readability } from './readability';
export { SNIPPET_FONT_TABLE } from './snippet-font';
export { STOP_WORDS } from './stop-words';
export { escapeHtml, formatPx, measureSnippet, snippetHtml, snippetText, textWidth, truncateToWidth, type SnippetCut, type SnippetMeasure } from './widths';
export { contentLanguage, hasSequence, isUnspaced, joinTerms, normaliseTerm, primaryLanguage, sentencesOf, stopWordsFor, termsOf, wordRuns, wordsOf, type ContentLanguage, type Word } from './words';
