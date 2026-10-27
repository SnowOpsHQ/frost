import type { PaletteShortcut } from './registry';

// The command palette's keyboard (acceptance `command-palette.feature.md`, Keyboard): what a key in
// the search box does to the list, and how a shortcut reads on this platform. Pure.

/** How far PageUp / PageDown move. */
export const PALETTE_PAGE_STEP = 8;

/** What a key does: move the active option, run it, close the palette, nothing (consumed), or `null` (the search box's own key). */
export type PaletteKeyAction = { readonly type: 'move'; readonly index: number } | { readonly type: 'run' } | { readonly type: 'close' } | { readonly type: 'none' };

export interface KeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * `key` in the search box with option `active` of `count` active: ↑/↓ and Tab/Shift+Tab move
 * (wrapping), PageUp/PageDown jump `PALETTE_PAGE_STEP` (clamped), Enter runs, Esc closes. Tab never
 * leaves the palette (it is consumed even with nothing listed). Arrows and Enter with Ctrl, Alt or
 * Meta, and every other key, are left to the search box.
 */
export function paletteKey(key: KeyPress, active: number, count: number): PaletteKeyAction | null {
  if (key.key === 'Escape') return { type: 'close' };
  const plain = !key.ctrlKey && !key.altKey && !key.metaKey;
  const wrap = (index: number) => ({ type: 'move', index: ((index % count) + count) % count }) as const;
  const clamp = (index: number) => ({ type: 'move', index: Math.max(0, Math.min(count - 1, index)) }) as const;
  switch (key.key) {
    case 'Tab':
      if (!plain) return null;
      return count === 0 ? { type: 'none' } : wrap(active + (key.shiftKey ? -1 : 1));
    case 'ArrowDown':
    case 'ArrowUp':
      if (!plain) return null;
      return count === 0 ? { type: 'none' } : wrap(active + (key.key === 'ArrowDown' ? 1 : -1));
    case 'PageDown':
    case 'PageUp':
      if (!plain) return null;
      return count === 0 ? { type: 'none' } : clamp(active + (key.key === 'PageDown' ? PALETTE_PAGE_STEP : -PALETTE_PAGE_STEP));
    case 'Enter':
      if (!plain) return null;
      return count === 0 || active < 0 ? { type: 'none' } : { type: 'run' };
    default:
      return null;
  }
}

const MAC_MODIFIERS: Readonly<Record<string, string>> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
/** macOS lists modifiers in this order. */
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const KEY_NAMES: Readonly<Record<string, string>> = { Left: '←', Right: '→', Up: '↑', Down: '↓' };

/** `shortcut` (`Mod+Shift+R`) as this platform shows it: `⇧⌘R` on macOS, `Ctrl+Shift+R` elsewhere. */
export function shortcutLabel(shortcut: PaletteShortcut, mac: boolean): string {
  const combo = typeof shortcut === 'string' ? shortcut : mac ? shortcut.mac : shortcut.other;
  const parts = combo.split('+');
  // `Mod++` would split into an empty key: the key is whatever follows the last modifier.
  const key = parts.pop() || '+';
  const name = KEY_NAMES[key] ?? key;
  if (mac) {
    const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_MODIFIERS[m]);
    return `${mods.join('')}${name}`;
  }
  return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), name].join('+');
}
