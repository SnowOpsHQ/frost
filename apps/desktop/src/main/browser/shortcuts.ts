import type { PageCommand } from '@app/specs/page-commands.spec';
import type { TabCommand } from '@app/specs/tabs.spec';

// Matches `before-input-event` input against `RESERVED_TAB_SHORTCUTS` (`specs/tabs.spec.ts`;
// acceptance `tabs.feature.md`, Shortcut matching) and `RESERVED_PAGE_SHORTCUTS`
// (`specs/page-commands.spec.ts`; `page-commands.feature.md`). Pure, no Electron import.

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
  /** A key-down repeated by holding the key (Electron's `Input.isAutoRepeat`). */
  readonly isAutoRepeat?: boolean;
}

/** The physical key, from `code`, else (input without one) guessed from `key` on a US layout. */
function physicalKey({ code, key }: KeyInput): string {
  if (code !== '') return code;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (key === ']' || key === '}') return 'BracketRight';
  if (key === '[' || key === '{') return 'BracketLeft';
  if (key === '=' || key === '+') return 'Equal';
  if (key === '-' || key === '_') return 'Minus';
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
    // The command palette (`command-palette.spec.ts`, `COMMAND_PALETTE_SHORTCUT`).
    case 'KeyK':
      return { command: 'command-palette' };
  }
  const digit = /^Digit([1-8])$/.exec(code);
  if (digit) return { command: 'select-tab', index: Number(digit[1]) - 1 };
  return null;
}

/** Mod+<key> (no Shift) page commands, by physical key, on every platform. */
const MOD_PAGE_KEYS: Readonly<Record<string, PageCommand>> = {
  KeyR: 'reload',
  Equal: 'zoom-in',
  NumpadAdd: 'zoom-in',
  Minus: 'zoom-out',
  NumpadSubtract: 'zoom-out',
  Digit0: 'zoom-reset',
  Numpad0: 'zoom-reset',
};

/**
 * The reserved page shortcut `input` is (key-down or key-up), or `null`: Mod+R / F5 reload,
 * Mod+Shift+R hard reload, Mod+= (also Mod+Shift+= and the keypad +) / Mod+- / Mod+0 zoom, and
 * back / forward as Cmd+[ / Cmd+] on macOS and Alt+Left / Alt+Right elsewhere. Mod is Meta on
 * macOS and Control elsewhere; the other one of the two must not be held. Not here (not reserved):
 * Cmd+Left / Cmd+Right and Esc (`UNRESERVED_PAGE_SHORTCUTS`).
 */
export function matchPageShortcut(input: KeyInput, platform: NodeJS.Platform): PageCommand | null {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return null;
  const mac = platform === 'darwin';
  const code = physicalKey(input);
  const mod = mac ? input.meta : input.control;
  const other = mac ? input.control : input.meta;

  if (code === 'F5') return !input.control && !input.meta && !input.alt && !input.shift ? 'reload' : null;

  if (input.alt) {
    // Alt+Left / Alt+Right, alone (never on macOS, where Option+arrows move by word).
    if (mac || input.control || input.meta || input.shift) return null;
    if (code === 'ArrowLeft') return 'back';
    if (code === 'ArrowRight') return 'forward';
    return null;
  }

  if (!mod || other) return null;
  if (input.shift) {
    if (code === 'KeyR') return 'hard-reload';
    if (code === 'Equal') return 'zoom-in';
    return null;
  }
  if (mac && code === 'BracketLeft') return 'back';
  if (mac && code === 'BracketRight') return 'forward';
  return MOD_PAGE_KEYS[code] ?? null;
}

/**
 * Whether `input` (key-down or key-up) is the SEO sidebar toggle, `Mod+Shift+S` (spec
 * `seo-sidebar.spec.ts`, `SIDEBAR_TOGGLE_SHORTCUT`): Mod is Meta on macOS and Control elsewhere,
 * the other one of the two and Alt not held; `S` by its physical key.
 */
export function matchSidebarShortcut(input: KeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return false;
  const mac = platform === 'darwin';
  const mod = mac ? input.meta : input.control;
  const other = mac ? input.control : input.meta;
  return mod && !other && !input.alt && input.shift && physicalKey(input) === 'KeyS';
}

/**
 * Whether `input` (key-down or key-up) is the SEO devtools drawer toggle, `Mod+Shift+D` (spec
 * `devtools.spec.ts`, `DEVTOOLS_TOGGLE_SHORTCUT`): as the sidebar's, with `D` by its physical key.
 */
export function matchDevtoolsShortcut(input: KeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return false;
  const mac = platform === 'darwin';
  const mod = mac ? input.meta : input.control;
  const other = mac ? input.control : input.meta;
  return mod && !other && !input.alt && input.shift && physicalKey(input) === 'KeyD';
}
