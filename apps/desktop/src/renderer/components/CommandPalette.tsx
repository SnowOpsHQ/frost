import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { PALETTE_EMPTY_MESSAGE, PALETTE_FAILED_MESSAGE, PALETTE_GROUPS, PALETTE_QUERY_MAX_CHARS, PALETTE_STATUS_MS } from '@app/specs/command-palette.spec';
import type { SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { useSeqChange } from '../hooks/useSeqChange';
import { actions } from '../ipc';
import { builtinPaletteSources } from '../palette/builtins';
import { PaletteIcon, PaletteMark, SearchGlyph } from '../palette/icons';
import { paletteKey, shortcutLabel } from '../palette/keys';
import { paletteSections, rankActions, type RankedAction } from '../palette/match';
import { pushRecent, readRecents, writeRecents } from '../palette/recents';
import { paletteRegistry, registerPaletteActions, type PaletteAction, type PaletteContext, type PanelJump } from '../palette/registry';
import { isolatedTooltip } from '../seo-view';

// The command palette (spec `command-palette.spec.ts`; acceptance `command-palette.feature.md`).
// Main opens it (Mod+K is reserved in `before-input-event`, View › Command Palette…) by bumping
// `BrowserState.commandPalette.seq`. While open it is a sheet at the top of the page column: the page
// area below shrinks and main lays the tab's view out below the sheet (the view is drawn above the
// chrome's DOM, so the palette must never be where the view is). ARIA combobox + listbox, fully
// keyboard-driven; no network requests; every string is React text (page text bidi-isolated).

// The built-ins, registered like any feature's actions (once per module instance).
const unregisterBuiltins = registerPaletteActions(...builtinPaletteSources(actions));
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
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const openRef = useRef(false);
  const origin = useRef<Origin | null>(null);
  const input = useRef<HTMLInputElement>(null);
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
  const current = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const close = (restore: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    const from = origin.current;
    origin.current = null;
    if (!restore || !from) return;
    if (from.kind === 'page') void actions.focusPage();
    else if (from.element?.isConnected) from.element.focus();
  };

  const openPalette = () => {
    const focused = document.activeElement;
    origin.current =
      state?.commandPalette.returnFocus === 'page'
        ? { kind: 'page' }
        : { kind: 'chrome', element: focused instanceof HTMLElement && focused !== document.body ? focused : null };
    openRef.current = true;
    pointer.current = null;
    setRecents(readRecents(storage()));
    setQuery('');
    setActive(0);
    setOpen(true);
  };

  // Main's request (Mod+K, the menu): open, or close if open.
  useSeqChange(state?.commandPalette.seq, () => (openRef.current ? close(true) : openPalette()));

  useLayoutEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (open && current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  }, [open, current]);

  const run = (item: RankedAction<PaletteAction>) => {
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
    if (result.type === 'move') setActive(result.index);
    else if (result.type === 'close') close(true);
    else if (result.type === 'run' && current >= 0) run(flat[current]!);
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
            if (last !== null && (last.x !== x || last.y !== y)) setActive(at);
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
                onChange={(event) => {
                  setQuery(event.target.value.slice(0, PALETTE_QUERY_MAX_CHARS));
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
              <kbd className="palette-kbd palette-esc" aria-hidden="true">
                Esc
              </kbd>
            </div>
            <div className="palette-list" id={listId} role="listbox" aria-label="Commands" data-testid="command-palette-list">
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
            {flat.length === 0 ? (
              <div className="palette-empty" data-testid="command-palette-empty">
                <PaletteMark className="palette-empty-mark" />
                <span>{PALETTE_EMPTY_MESSAGE}</span>
              </div>
            ) : null}
            <footer className="palette-foot" aria-hidden="true">
              <span className="palette-foot-hint">
                <kbd className="palette-kbd">↑</kbd>
                <kbd className="palette-kbd">↓</kbd>
                <span className="palette-foot-label">to move</span>
              </span>
              <span className="palette-foot-hint">
                <kbd className="palette-kbd">↵</kbd>
                <span className="palette-foot-label">to run</span>
              </span>
              <span className="palette-foot-hint">
                <kbd className="palette-kbd">Esc</kbd>
                <span className="palette-foot-label">to close</span>
              </span>
              <span className="palette-foot-count" data-testid="command-palette-count">
                {flat.length === 1 ? '1 command' : `${flat.length} commands`}
              </span>
            </footer>
            <span className="visually-hidden" role="status" aria-live="polite">
              {flat.length === 0 ? PALETTE_EMPTY_MESSAGE : `${flat.length} commands`}
            </span>
          </div>
        </div>
      ) : null}
      <div className="palette-status" role="status" aria-live="polite" data-testid="command-palette-status" data-shown={status !== ''}>
        {status}
      </div>
    </>
  );
}
