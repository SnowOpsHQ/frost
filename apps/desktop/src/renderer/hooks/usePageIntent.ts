import { useEffect, useState } from 'react';
import type { IntentAnswer, IntentState } from '@app/specs/intent-classifier.spec';
import { ipc } from '../ipc';
import { intentQuery } from '../page-type-view';
import { classifyQueryInput } from '../visibility-view';
import { serpActions, useIntentState } from './useSerp';

// The intent of a page's target query, for the Overview's "Page" card (acceptance
// `page-type.feature.md`): the target is read from the Content panel's notes (`content.getNotes`,
// read only), and classified on this device (`serp.classify`) only when one is set and on-device
// intent is `ready`. Nothing here downloads or sends the query anywhere.

export interface PageIntent {
  /** The stored target query (trimmed and capped as the query box sends it; `''`: none set); `null` until read. */
  readonly target: string | null;
  readonly intentState: IntentState | null;
  /** The classifier's answer for `target` (`null`: not asked, or not answered yet). */
  readonly answer: IntentAnswer | null;
}

/** `generation`: main's notes generation (`BrowserState.contentNotesGeneration`): a change reads the target again. */
export function usePageIntent(url: string, generation = 0): PageIntent {
  const [stored, setStored] = useState<{ readonly url: string; readonly query: string } | null>(null);
  useEffect(() => {
    let live = true;
    ipc.content.getNotes
      .query({ url })
      .then((notes) => live && setStored({ url, query: notes.query }))
      .catch(() => live && setStored({ url, query: '' }));
    return () => {
      live = false;
    };
  }, [url, generation]);
  const target = stored?.url === url ? (classifyQueryInput(stored.query) ?? '') : null;
  const [intentState] = useIntentState(target);
  const ask = intentQuery(target, intentState);
  const [answered, setAnswered] = useState<{ readonly query: string; readonly answer: IntentAnswer } | null>(null);
  useEffect(() => {
    if (ask === null) return;
    let live = true;
    void serpActions.classify(ask).then((answer) => {
      if (live) setAnswered({ query: ask, answer: answer ?? { state: 'unavailable' } });
    });
    return () => {
      live = false;
    };
  }, [ask]);
  return { target, intentState, answer: ask !== null && answered?.query === ask ? answered.answer : null };
}
