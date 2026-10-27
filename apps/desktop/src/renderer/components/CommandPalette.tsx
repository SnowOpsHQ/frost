import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import {
  OPEN_IN_BACK_LABEL,
  PALETTE_EMPTY_MESSAGE,
  PALETTE_FAILED_MESSAGE,
  PALETTE_GROUPS,
  PALETTE_QUERY_MAX_CHARS,
  PALETTE_STATUS_MS,
  PALETTE_TOO_SHORT_MESSAGE,
} from '@app/specs/command-palette.spec';
import type { SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { useSeqChange } from '../hooks/useSeqChange';
import { actions } from '../ipc';
import { builtinPaletteSources } from '../palette/builtins';
import { createConsentStore } from '../palette/consent';
import { PaletteIcon, PaletteMark, SearchGlyph } from '../palette/icons';
import { paletteKey, resolveActive, shortcutLabel } from '../palette/keys';
import { closesForFullscreen, paletteFits } from '../palette/layout';
import { paletteSections, rankActions, type RankedAction } from '../palette/match';
import { pushRecent, readRecents, writeRecents } from '../palette/recents';
import { paletteRegistry, registerPaletteActions, type PaletteAction, type PaletteConfirm, type PaletteContext, type PanelJump } from '../palette/registry';
import { isolatedTooltip } from '../seo-view';

// The command palette (spec `command-palette.spec.ts`; acceptance `command-palette.feature.md`).
// Main opens it (Mod+K is reserved in `before-input-event`, View › Command Palette…) by bumping
// `BrowserState.commandPalette.seq`. While open it is a sheet at the top of the page column: the page
// area below shrinks and main lays the tab's view out below the sheet (the view is drawn above the
// chrome's DOM, so the palette must never be where the view is). ARIA combobox + listbox, fully
// keyboard-driven; no network requests; every string is React text (page text bidi-isolated).
// The active option is kept as an action id, so a list that changes under it never makes Enter run
// another action. An action may ask first ("Open in": once per destination host), as an inline step.
// It never opens in a page column too short to show it, and closes when the page goes fullscreen.

// The built-ins, registered like any feature's actions (once per module instance); "Open in" keeps
// its per-host answers in the chrome's own localStorage (a preference, not browsing data).
const unregisterBuiltins = registerPaletteActions(...builtinPaletteSources(actions, createConsentStore(storage())));
import.meta.hot?.dispose(unregisterBuiltins);

const MAC = /\bMac/.test(navigator.userAgent);
const GROUP_LABELS: Readonly<Record<string, string>> = Object.fromEntries(PALETTE_GROUPS.map((g) => [g.id, g.label]));

/** The chrome's own `localStorage`; `null` if it cannot be reached. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Where focus goes back to on close. */
type Origin = { readonly kind: 'page' } | { readonly kind: 'chrome'; readonly element: HTMLElement | null };

/** `label` with the matched code points marked. */
function Highlighted({ label, indices }: { readonly label: string; readonly indices: readonly number[] }) {
  if (indices.length === 0) return <>{label}</>;
  const marked = new Set(indices);
  const chars = Array.from(label);
  const parts: { text: string; hit: boolean }[] = [];
  chars.forEach((char, i) => {
    const hit = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += char;
    else parts.push({ text: char, hit });
  });
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="palette-hit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** One option row. */
function Option({
  id,
  item,
  ctx,
  selected,
  showGroup,
  onHover,
  onRun,
}: {
  readonly id: string;
  readonly item: RankedAction<PaletteAction>;
  readonly ctx: PaletteContext;
  readonly selected: boolean;
  readonly showGroup: boolean;
  readonly onHover: (x: number, y: number) => void;
  readonly onRun: () => void;
}) {
  const { action } = item;
  let detail: string | null = null;
  try {
    detail = action.detail?.(ctx) ?? null;
  } catch {
    detail = null;
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className="palette-option"
      data-testid="command-palette-option"
      data-action={action.id}
      data-active={selected}
      onMouseMove={(event) => onHover(event.clientX, event.clientY)}
      // Keep focus in the search box: the click runs the option.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      <span className="palette-option-icon" aria-hidden="true">
        <PaletteIcon name={action.icon} group={action.group} />
      </span>
      <span className="palette-option-text">
        <span className="palette-option-label">
          <Highlighted label={action.label} indices={item.indices} />
        </span>
        {detail ? (
          <bdi className="palette-option-detail" dir="auto" title={isolatedTooltip(detail)} data-testid="command-palette-detail">
            {detail}
          </bdi>
        ) : null}
      </span>
      {showGroup ? <span className="palette-option-group">{GROUP_LABELS[action.group]}</span> : null}
      {action.shortcut ? <kbd className="palette-kbd">{shortcutLabel(action.shortcut, MAC)}</kbd> : null}
    </div>
  );
}

export function CommandPalette({
  state,
  tab,
  audit,
  sidebarOpen,
  onSidebarOpenChange,
  onPanelJump,
}: {
  readonly state: BrowserState | null;
  readonly tab: TabState | undefined;
  readonly audit: SeoAuditResponse | null;
  readonly sidebarOpen: boolean;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onPanelJump: (jump: PanelJump) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The active option, by action id (`null`: the first row).
  const [activeId, setActiveId] = useState<string | null>(null);
  // An action waiting for the user's answer to its question (`PaletteConfirm`).
  const [pending, setPending] = useState<{ readonly item: RankedAction<PaletteAction>; readonly step: PaletteConfirm } | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const openRef = useRef(false);
  const origin = useRef<Origin | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const acceptButton = useRef<HTMLButtonElement>(null);
  const jumps = useRef(0);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  useEffect(() => () => clearTimeout(statusTimer.current), []);
  const flash = (message: string) => {
    clearTimeout(statusTimer.current);
    setStatus(message);
    statusTimer.current = setTimeout(() => setStatus(''), PALETTE_STATUS_MS);
  };

  const ctx = useMemo<PaletteContext>(
    () => ({
      state,
      tab,
      audit,
      sidebarOpen,
      chrome: {
        openPanel: (panel: SeoPanelId, options) => {
          jumps.current += 1;
          onPanelJump({ panel, focus: options?.focus === true, seq: jumps.current });
        },
        setSidebarOpen: onSidebarOpenChange,
      },
    }),
    [state, tab, audit, sidebarOpen, onSidebarOpenChange, onPanelJump],
  );

  const available = useMemo(() => (open ? paletteRegistry.resolve(ctx) : []), [open, ctx]);
  const ranked = useMemo(() => rankActions(query, available, recents), [query, available, recents]);
  const sections = useMemo(() => paletteSections(query, ranked), [query, ranked]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const current = resolveActive(
    flat.map((item) => item.action.id),
    activeId,
  );
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const close = (restore: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    setPending(null);
    const from = origin.current;
    origin.current = null;
    if (!restore || !from) return;
    if (from.kind === 'page') void actions.focusPage();
    else if (from.element?.isConnected) from.element.focus();
  };

  const openPalette = () => {
    const fromPage = state?.commandPalette.returnFocus === 'page';
    // Never open invisible: a page column too short for the sheet says so instead.
    const column = anchor.current?.parentElement?.getBoundingClientRect().height ?? Number.NaN;
    if (!paletteFits(column)) {
      flash(PALETTE_TOO_SHORT_MESSAGE);
      if (fromPage) void actions.focusPage();
      return;
    }
    const focused = document.activeElement;
    origin.current = fromPage ? { kind: 'page' } : { kind: 'chrome', element: focused instanceof HTMLElement && focused !== document.body ? focused : null };
    openRef.current = true;
    pointer.current = null;
    setRecents(readRecents(storage()));
    setQuery('');
    setActiveId(null);
    setPending(null);
    setOpen(true);
  };

  // Main's request (Mod+K, the menu): open, or close if open.
  useSeqChange(state?.commandPalette.seq, () => (openRef.current ? close(true) : openPalette()));

  useLayoutEffect(() => {
    if (open && pending === null) input.current?.focus();
    else if (open) acceptButton.current?.focus();
  }, [open, pending]);
  // The page went fullscreen: its view now covers the chrome, the palette too. Close, and leave focus alone.
  const fullscreen = tab?.fullscreen ?? null;
  useEffect(() => {
    if (open && closesForFullscreen(tab)) close(false);
  }, [open, fullscreen]);
  useLayoutEffect(() => {
    if (open && current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  }, [open, current]);

  /** Runs `item`, or asks its question first (`PaletteConfirm`). */
  const run = (item: RankedAction<PaletteAction>) => {
    let step: PaletteConfirm | null = null;
    try {
      step = item.action.confirm?.(ctx) ?? null;
    } catch {
      step = null;
    }
    if (step) setPending({ item, step });
    else execute(item);
  };

  const accept = () => {
    if (!pending) return;
    try {
      pending.step.accept();
    } catch {
      // The answer is not kept; the action still runs this once.
    }
    execute(pending.item);
  };

  const back = () => {
    setPending(null);
  };

  const execute = (item: RankedAction<PaletteAction>) => {
    const { action } = item;
    const next = pushRecent(recents, action.id);
    setRecents(next);
    writeRecents(storage(), next);
    const context = ctx;
    close(action.focus !== 'handler');
    void Promise.resolve()
      .then(() => action.run(context))
      .then(
        (outcome) => {
          if (typeof outcome === 'string' && outcome !== '') flash(outcome);
        },
        () => flash(PALETTE_FAILED_MESSAGE),
      );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const result = paletteKey(event, current, flat.length);
    if (result === null) return;
    event.preventDefault();
    if (result.type === 'move') setActiveId(flat[result.index]?.action.id ?? null);
    else if (result.type === 'close') close(true);
    else if (result.type === 'run' && current >= 0) run(flat[current]!);
  };

  // The question step: Esc goes back to the list; Tab stays on its two buttons.
  const onConfirmKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      back();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  };

  // Focus leaving the palette (a click in the chrome or on the page, another window) closes it,
  // leaving focus where the user put it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    close(false);
  };

  let index = -1;
  const renderItems = (items: readonly RankedAction<PaletteAction>[], showGroup: boolean) =>
    items.map((item) => {
      index += 1;
      const at = index;
      return (
        <Option
          key={item.action.id}
          id={optionId(at)}
          item={item}
          ctx={ctx}
          selected={at === current}
          showGroup={showGroup}
          onHover={(x, y) => {
            // Only a pointer that really moved picks an option (not the list scrolling under a still one).
            const last = pointer.current;
            pointer.current = { x, y };
            if (last !== null && (last.x !== x || last.y !== y)) setActiveId(item.action.id);
          }}
          onRun={() => run(item)}
        />
      );
    });

  return (
    <>
      {open ? (
        <div className="palette-sheet" data-testid="command-palette-sheet">
          <div
            className="palette"
            role="dialog"
            aria-label="Command palette"
            data-testid="command-palette"
            onBlur={onBlur}
          >
            <div className="palette-search">
              <SearchGlyph className="palette-search-icon" />
              <input
                ref={input}
                className="palette-input"
                data-testid="command-palette-input"
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={current >= 0 ? optionId(current) : undefined}
                aria-label="Search commands"
                placeholder="Search commands…"
                autoComplete="off"
                spellCheck={false}
                maxLength={PALETTE_QUERY_MAX_CHARS}
                value={query}
                readOnly={pending !== null}
                onChange={(event) => {
                  setQuery(event.target.value.slice(0, PALETTE_QUERY_MAX_CHARS));
                  setActiveId(null);
                }}
                onKeyDown={onKeyDown}
              />
              <kbd className="palette-kbd palette-esc" aria-hidden="true">
                Esc
              </kbd>
            </div>
            {pending ? (
              <div className="palette-confirm" role="group" aria-labelledby={`${baseId}-confirm`} data-testid="command-palette-confirm" data-action={pending.item.action.id} onKeyDown={onConfirmKey}>
                <span className="palette-confirm-icon" aria-hidden="true">
                  <PaletteIcon name={pending.item.action.icon} group={pending.item.action.group} />
                </span>
                <p className="palette-confirm-title">{pending.item.action.label}</p>
                <p id={`${baseId}-confirm`} className="palette-confirm-message" data-testid="command-palette-confirm-message">
                  {pending.step.message}
                </p>
                {pending.step.note ? (
                  <p className="palette-confirm-note" data-testid="command-palette-confirm-note">
                    {pending.step.note}
                  </p>
                ) : null}
                <div className="palette-confirm-actions">
                  <button type="button" className="palette-button" data-testid="command-palette-confirm-back" onClick={back}>
                    {OPEN_IN_BACK_LABEL}
                  </button>
                  <button ref={acceptButton} type="button" className="palette-button palette-button-primary" data-testid="command-palette-confirm-accept" onClick={accept}>
                    {pending.step.confirmLabel}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="palette-list" id={listId} role="listbox" aria-label="Commands" data-testid="command-palette-list" hidden={pending !== null}>
              {sections.map((section) =>
                section.label === null ? (
                  renderItems(section.items, true)
                ) : (
                  <div key={section.id} role="group" aria-labelledby={`${baseId}-group-${section.id}`} className="palette-group" data-testid="command-palette-group" data-group={section.id}>
                    <div id={`${baseId}-group-${section.id}`} className="palette-group-label" role="presentation">
                      {section.label}
                    </div>
                    {renderItems(section.items, false)}
                  </div>
                ),
              )}
            </div>
            {flat.length === 0 && pending === null ? (
              <div className="palette-empty" data-testid="command-palette-empty">
                <PaletteMark className="palette-empty-mark" />
                <span>{PALETTE_EMPTY_MESSAGE}</span>
              </div>
            ) : null}
            <footer className="palette-foot" aria-hidden="true" data-step={pending ? 'confirm' : 'list'}>
              <span className="palette-foot-hint palette-foot-list">
                <kbd className="palette-kbd">↑</kbd>
                <kbd className="palette-kbd">↓</kbd>
                <span className="palette-foot-label">to move</span>
              </span>
              <span className="palette-foot-hint">
                <kbd className="palette-kbd">↵</kbd>
                <span className="palette-foot-label">{pending ? 'to confirm' : 'to run'}</span>
              </span>
              <span className="palette-foot-hint">
                <kbd className="palette-kbd">Esc</kbd>
                <span className="palette-foot-label">{pending ? 'to go back' : 'to close'}</span>
              </span>
              <span className="palette-foot-count palette-foot-list" data-testid="command-palette-count">
                {flat.length === 1 ? '1 command' : `${flat.length} commands`}
              </span>
            </footer>
            <span className="visually-hidden" role="status" aria-live="polite">
              {flat.length === 0 ? PALETTE_EMPTY_MESSAGE : `${flat.length} commands`}
            </span>
          </div>
        </div>
      ) : null}
      {/* Its parent is the page column: measured before opening (never open invisible). */}
      <span ref={anchor} hidden />
      <div className="palette-status" role="status" aria-live="polite" data-testid="command-palette-status" data-shown={status !== ''}>
        {status}
      </div>
    </>
  );
}
