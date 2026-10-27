import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentVariant } from '@app/ipc-contract';
import { firstFreeSlot } from '../content-view';
import { ipc } from '../ipc';

// The Content panel's notes for one page URL (acceptance `seo-content.feature.md`): the target query
// and the snippet drafts live in main's database (`content.*` procedures). Edits show at once and are
// saved after `SAVE_DELAY_MS` without another edit; `flush()` saves whatever is pending now (before a
// copy, when the page changes, when the panel closes).

export const SAVE_DELAY_MS = 400;

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

export function useContentNotes(url: string): ContentNotesApi {
  const [state, setState] = useState<NotesState>({ url, loaded: false, query: '', drafts: [] });
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<unknown> }>());

  const flush = useCallback(async () => {
    const runs = [...pending.current.values()];
    pending.current.clear();
    for (const entry of runs) clearTimeout(entry.timer);
    await Promise.all(runs.map((entry) => entry.run().catch(ignore)));
  }, []);

  const schedule = useCallback((key: string, run: () => Promise<unknown>) => {
    const previous = pending.current.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      pending.current.delete(key);
      void run().catch(ignore);
    }, SAVE_DELAY_MS);
    pending.current.set(key, { timer, run });
  }, []);

  useEffect(() => {
    let live = true;
    setState({ url, loaded: false, query: '', drafts: [] });
    ipc.content.getNotes
      .query({ url })
      .then((notes) => {
        if (live) setState({ url, loaded: true, query: notes.query, drafts: notes.variants.map(toDraft) });
      })
      .catch(() => {
        if (live) setState({ url, loaded: true, query: '', drafts: [] });
      });
    return () => {
      live = false;
      // Edits made for this URL are saved for it, not lost.
      void flush();
    };
  }, [url, flush]);

  const setQuery = (query: string) => {
    setState((s) => ({ ...s, query }));
    schedule('query', () => ipc.content.setTarget.mutate({ url, query }));
  };

  const updateDraft = (draft: Draft) => {
    setState((s) => ({ ...s, drafts: s.drafts.map((d) => (d.slot === draft.slot ? draft : d)) }));
    schedule(`draft:${draft.slot}`, () => ipc.content.saveVariant.mutate({ url, ...draft }));
  };

  const addDraft = (title: string, description: string): number | null => {
    const slot = firstFreeSlot(state.drafts.map((d) => d.slot));
    if (slot === null) return null;
    const draft = { slot, title, description };
    setState((s) => ({ ...s, drafts: [...s.drafts, draft].sort((a, b) => a.slot - b.slot) }));
    schedule(`draft:${slot}`, () => ipc.content.saveVariant.mutate({ url, ...draft }));
    return slot;
  };

  const deleteDraft = (slot: number) => {
    const key = `draft:${slot}`;
    const queued = pending.current.get(key);
    if (queued) clearTimeout(queued.timer);
    pending.current.delete(key);
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.slot !== slot) }));
    void ipc.content.deleteVariant.mutate({ url, slot }).catch(ignore);
  };

  return { ...state, setQuery, updateDraft, addDraft, deleteDraft, flush };
}

/** Copy as HTML through main (`content.copySnippetHtml`); resolves whether it was written. */
export function copySnippetHtml(tabId: number, audit: { url: string; takenAt: number }, slot: number | null): Promise<boolean> {
  const input = slot === null ? { tabId, audit, source: 'page' as const } : { tabId, audit, source: 'variant' as const, slot };
  return ipc.content.copySnippetHtml.mutate(input).catch(() => false);
}
