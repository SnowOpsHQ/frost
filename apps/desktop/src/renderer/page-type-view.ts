import type { PageTypeReport } from '@app/seo-core';
import type { IntentState } from '@app/specs/intent-classifier.spec';
import { PAGE_TYPE_CONFIDENCE_LABELS, PAGE_TYPE_COPY, PAGE_TYPE_LABELS, PAGE_TYPE_SIGNAL_LABELS, type PageTypeConfidence, type PageTypeSignal } from '@app/specs/page-type.spec';

// The Overview's "Page" card (acceptance `page-type.feature.md`, Overview "Page" card): the page
// type seo-core worked out on this device, and when to classify the page's target query. Pure; every
// string is frost's own (`PAGE_TYPE_COPY`), and a signal's evidence is frost's wording too.

export interface PageTypeSignalView {
  readonly signal: PageTypeSignal;
  readonly label: string;
  readonly type: string;
  readonly evidence: string;
  /** It names the type shown. */
  readonly agrees: boolean;
}

export interface PageTypeView {
  readonly label: string;
  readonly confidence: PageTypeConfidence;
  readonly confidenceLabel: string;
  readonly signals: readonly PageTypeSignalView[];
  /** Why frost is unsure (no signal, or a conflict); `null` otherwise. */
  readonly note: string | null;
}

export function pageTypeView(report: PageTypeReport): PageTypeView {
  const signals = report.signals.map((hit) => ({ signal: hit.signal, label: PAGE_TYPE_SIGNAL_LABELS[hit.signal], type: PAGE_TYPE_LABELS[hit.type], evidence: hit.evidence, agrees: hit.type === report.type }));
  const note = report.confidence !== 'unsure' ? null : signals.length === 0 ? PAGE_TYPE_COPY.noSignals : PAGE_TYPE_COPY.conflict;
  return { label: PAGE_TYPE_LABELS[report.type], confidence: report.confidence, confidenceLabel: PAGE_TYPE_CONFIDENCE_LABELS[report.confidence], signals, note };
}

/** The query to classify on this device: the stored target, only once on-device intent is `ready` (`null`: classify nothing). */
export function intentQuery(target: string | null, state: IntentState | null): string | null {
  return target !== null && target !== '' && state === 'ready' ? target : null;
}

/** What the card says in place of an intent (`null`: nothing). */
export function intentNote(target: string | null, state: IntentState | null): string | null {
  if (target === null) return null;
  if (target === '') return PAGE_TYPE_COPY.noTarget;
  if (state === 'model-missing') return PAGE_TYPE_COPY.intentOff;
  if (state === 'unavailable') return PAGE_TYPE_COPY.intentUnavailable;
  return null;
}
