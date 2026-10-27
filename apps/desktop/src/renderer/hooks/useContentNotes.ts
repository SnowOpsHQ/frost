import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentVariant } from '@app/ipc-contract';
import { firstFreeSlot } from '../content-view';
import { ipc } from '../ipc';

// The Content panel's notes for one page URL (acceptance `seo-content.feature.md`): the target query
// and the snippet drafts live in main's database (`content.*` procedures). Edits show at once and are
// saved after `SAVE_DELAY_MS` without another edit; `flush()` saves whatever is pending now (before a
// copy, when the page changes, when the panel closes).
//
// Main counts the deletions of every note (`BrowserState.contentNotesGeneration`: Clear Browsing Data
// with its box ticked, "Delete all notes"). When that changes, the view drops its pending edits and
// reads its notes again. Each write carries the generation its notes were read in, and main refuses
// one from another, so an edit in flight during a deletion cannot bring a note back.

export const SAVE_DELAY_MS = 400;

/**
 * "Delete all notes" through main (`content.clearAllNotes`: it asks first); resolves whether they
 * were deleted. When they were, main's notes generation goes up and every open notes view resets.
 */
export function clearAllContentNotes(): Promise<boolean> {
  return ipc.content.clearAllNotes.mutate().catch(() => false);
}

export interface Draft {
  readonly slot: number;
  readonly title: string;
  readonly description: string;
}

interface NotesState {
  readonly url: string;
  readonly loaded: boolean;
  readonly query: string;
  readonly drafts: readonly Draft[];
}

export interface ContentNotesApi extends NotesState {
  setQuery(query: string): void;
  updateDraft(draft: Draft): void;
  /** Adds a draft in the first free slot; resolves its slot (`null`: every slot is taken). */
  addDraft(title: string, description: string): number | null;
  deleteDraft(slot: number): void;
  /** Saves everything pending now; resolves once main answered. */
  flush(): Promise<void>;
}

const ignore = (): void => undefined;

const toDraft = (variant: ContentVariant): Draft => ({ slot: variant.slot, title: variant.title, description: variant.description });

/** `generation`: main's notes generation (`BrowserState.contentNotesGeneration`). */
export function useContentNotes(url: string, generation = 0): ContentNotesApi {
  const [state, setState] = useState<NotesState>({ url, loaded: false, query: '', drafts: [] });
  // Each pending save with the generation it was made in.
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<unknown>; from: number }>());
  // The generation the shown notes were read in (each write carries it), and main's latest one.
  const readIn = useRef(generation);
  const latest = useRef(generation);
  latest.current = generation;

  const flush = useCallback(async () => {
    const runs = [...pending.current.values()];
    pending.current.clear();
    for (const entry of runs) clearTimeout(entry.timer);
    await Promise.all(runs.map((entry) => entry.run().catch(ignore)));
  }, []);

  const schedule = useCallback((key: string, from: number, run: (from: number) => Promise<unknown>) => {
    const previous = pending.current.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      pending.current.delete(key);
      void run(from).catch(ignore);
    }, SAVE_DELAY_MS);
    pending.current.set(key, { timer, run: () => run(from), from });
  }, []);

  useEffect(() => {
    let live = true;
    setState({ url, loaded: false, query: '', drafts: [] });
    ipc.content.getNotes
      .query({ url })
      .then((notes) => {
        if (!live) return;
        readIn.current = notes.generation;
        setState({ url, loaded: true, query: notes.query, drafts: notes.variants.map(toDraft) });
      })
      .catch(() => {
        if (!live) return;
        readIn.current = latest.current;
        setState({ url, loaded: true, query: '', drafts: [] });
      });
    return () => {
      live = false;
      // Every note was deleted since an edit not yet saved was made: it would bring a note back, so it
      // goes too (main would refuse it anyway).
      for (const [key, entry] of pending.current) {
        if (entry.from >= latest.current) continue;
        clearTimeout(entry.timer);
        pending.current.delete(key);
      }
      // Edits made for this URL are saved for it, not lost.
      void flush();
    };
  }, [url, flush, generation]);

  const setQuery = (query: string) => {
    setState((s) => ({ ...s, query }));
    schedule('query', readIn.current, (from) => ipc.content.setTarget.mutate({ url, query, generation: from }));
  };

  const updateDraft = (draft: Draft) => {
    setState((s) => ({ ...s, drafts: s.drafts.map((d) => (d.slot === draft.slot ? draft : d)) }));
    schedule(`draft:${draft.slot}`, readIn.current, (from) => ipc.content.saveVariant.mutate({ url, ...draft, generation: from }));
  };

  const addDraft = (title: string, description: string): number | null => {
    const slot = firstFreeSlot(state.drafts.map((d) => d.slot));
    if (slot === null) return null;
    const draft = { slot, title, description };
    setState((s) => ({ ...s, drafts: [...s.drafts, draft].sort((a, b) => a.slot - b.slot) }));
    schedule(`draft:${slot}`, readIn.current, (from) => ipc.content.saveVariant.mutate({ url, ...draft, generation: from }));
    return slot;
  };

  const deleteDraft = (slot: number) => {
    const key = `draft:${slot}`;
    const queued = pending.current.get(key);
    if (queued) clearTimeout(queued.timer);
    pending.current.delete(key);
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.slot !== slot) }));
    void ipc.content.deleteVariant.mutate({ url, slot, generation: readIn.current }).catch(ignore);
  };

  return { ...state, setQuery, updateDraft, addDraft, deleteDraft, flush };
}

/** Copy as HTML through main (`content.copySnippetHtml`); resolves whether it was written. */
export function copySnippetHtml(tabId: number, audit: { url: string; takenAt: number }, slot: number | null): Promise<boolean> {
  const input = slot === null ? { tabId, audit, source: 'page' as const } : { tabId, audit, source: 'variant' as const, slot };
  return ipc.content.copySnippetHtml.mutate(input).catch(() => false);
}
