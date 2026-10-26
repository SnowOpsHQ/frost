import type { TabCommand } from '@app/specs/tabs.spec';

// Matches `before-input-event` input against `RESERVED_TAB_SHORTCUTS` (`specs/tabs.spec.ts`;
// acceptance `tabs.feature.md`, Shortcut matching). Pure, no Electron import.

/** A matched shortcut: its command, and for `select-tab` the tab index (0…7). */
export type TabShortcut = { readonly command: Exclude<TabCommand, 'select-tab'> } | { readonly command: 'select-tab'; readonly index: number };

/** The fields of Electron's `Input` (from `before-input-event`) the matcher reads. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** The physical key, from `code`, else (input without one) guessed from `key` on a US layout. */
function physicalKey({ code, key }: KeyInput): string {
  if (code !== '') return code;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (key === ']' || key === '}') return 'BracketRight';
  if (key === '[' || key === '{') return 'BracketLeft';
  return key;
}

/**
 * The reserved tab shortcut `input` is (its key-down or key-up), or `null`. Mod is Meta on macOS and
 * Control elsewhere, and the other one of the two must not be held; Alt never is. Letters and digits
 * are matched by their physical key (`code`), so Caps Lock and layouts that shift digits don't matter.
 */
export function matchTabShortcut(input: KeyInput, platform: NodeJS.Platform): TabShortcut | null {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return null;
  if (input.alt) return null;
  const mac = platform === 'darwin';
  const code = physicalKey(input);

  // Ctrl+Tab / Ctrl+Shift+Tab: Control on every platform (never with Meta).
  if (code === 'Tab') {
    if (!input.control || input.meta) return null;
    return { command: input.shift ? 'previous-tab' : 'next-tab' };
  }

  const mod = mac ? input.meta : input.control;
  const other = mac ? input.control : input.meta;
  if (!mod || other) return null;

  if (input.shift) {
    // macOS only: Cmd+Shift+] / Cmd+Shift+[.
    if (!mac) return null;
    if (code === 'BracketRight') return { command: 'next-tab' };
    if (code === 'BracketLeft') return { command: 'previous-tab' };
    return null;
  }

  switch (code) {
    case 'KeyT':
      return { command: 'new-tab' };
    case 'KeyW':
      return { command: 'close-tab' };
    case 'KeyL':
      return { command: 'focus-address-bar' };
    case 'Digit9':
      return { command: 'select-last-tab' };
  }
  const digit = /^Digit([1-8])$/.exec(code);
  if (digit) return { command: 'select-tab', index: Number(digit[1]) - 1 };
  return null;
}
