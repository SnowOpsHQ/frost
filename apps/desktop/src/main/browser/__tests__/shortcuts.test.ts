// Spec: specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS), specs/page-commands.spec.ts (RESERVED_PAGE_SHORTCUTS)
// Acceptance: specs/tabs.feature.md (Shortcut matching), specs/page-commands.feature.md (Shortcut matching),
// specs/seo-sidebar.feature.md (Toggle)
import { describe, expect, test } from 'vitest';
import { RESERVED_PAGE_SHORTCUTS, UNRESERVED_PAGE_SHORTCUTS, type PageCommand } from '@app/specs/page-commands.spec';
import { RESERVED_TAB_SHORTCUTS, type TabCommand } from '@app/specs/tabs.spec';
import { SIDEBAR_TOGGLE_SHORTCUT } from '@app/specs/seo-sidebar.spec';
import { matchPageShortcut, matchSidebarShortcut, matchTabShortcut, type KeyInput } from '../shortcuts';

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

/** The `before-input-event` input Electron reports for a spec combo such as `Mod+Shift+]`. */
function inputFor(combo: string, platform: NodeJS.Platform): KeyInput {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const input: { -readonly [K in keyof KeyInput]: KeyInput[K] } = { type: 'keyDown', key, code: '', control: false, meta: false, shift: false, alt: false };
  for (const modifier of parts) {
    if (modifier === 'Mod') input[platform === 'darwin' ? 'meta' : 'control'] = true;
    else if (modifier === 'Ctrl') input.control = true;
    else if (modifier === 'Shift') input.shift = true;
    else if (modifier === 'Alt') input.alt = true;
    else throw new Error(`unknown modifier ${modifier}`);
  }
  // Page-command keys (a US layout: Shift turns `=` into `+` and `-` into `_`).
  const named: Record<string, [string, string]> = {
    '=': [input.shift ? '+' : '=', 'Equal'],
    '-': [input.shift ? '_' : '-', 'Minus'],
    Left: ['ArrowLeft', 'ArrowLeft'],
    Right: ['ArrowRight', 'ArrowRight'],
    F5: ['F5', 'F5'],
    Escape: ['Escape', 'Escape'],
    NumpadAdd: ['+', 'NumpadAdd'],
    NumpadSubtract: ['-', 'NumpadSubtract'],
    Numpad0: ['0', 'Numpad0'],
  };
  const special = named[key];
  if (special) return Object.assign(input, { key: special[0], code: special[1] });
  if (/^[A-Z]$/.test(key)) Object.assign(input, { key: key.toLowerCase(), code: `Key${key}` });
  else if (/^\d$/.test(key)) input.code = `Digit${key}`;
  else if (key === 'Tab') input.code = 'Tab';
  // Shift turns the bracket keys into braces on a US layout; the physical key stays the same.
  else if (key === ']') Object.assign(input, { key: input.shift ? '}' : ']', code: 'BracketRight' });
  else if (key === '[') Object.assign(input, { key: input.shift ? '{' : '[', code: 'BracketLeft' });
  return input;
}

describe('tab shortcut matching', () => {
  test.each(PLATFORMS)('shortcut-matcher-follows-spec (%s)', (platform) => {
    const mac = platform === 'darwin';
    for (const [command, combos] of Object.entries(RESERVED_TAB_SHORTCUTS) as [TabCommand, readonly string[]][]) {
      combos.forEach((entry, i) => {
        const macOnly = entry.startsWith('mac:');
        const combo = entry.replace(/^mac:/, '');
        const match = matchTabShortcut(inputFor(combo, platform), platform);
        if (macOnly && !mac) {
          expect(match, `${entry} off macOS`).toBeNull();
          return;
        }
        expect(match, entry).toEqual(command === 'select-tab' ? { command, index: i } : { command });
        // Key-up of the same combo matches too (the handler consumes it without running again).
        expect(matchTabShortcut({ ...inputFor(combo, platform), type: 'keyUp' }, platform), `${entry} up`).toEqual(match);
      });
    }

    const mod = mac ? 'meta' : 'control';
    const other = mac ? 'control' : 'meta';
    const t = inputFor('Mod+T', platform);
    // Not ours: plain keys, extra modifiers, the other platform's modifier.
    expect(matchTabShortcut({ ...t, [mod]: false }, platform)).toBeNull();
    expect(matchTabShortcut({ ...t, alt: true }, platform)).toBeNull();
    // Mod+Shift+T is Reopen Closed Tab (`browser-polish.spec.ts`), not New Tab.
    expect(matchTabShortcut({ ...t, shift: true, key: 'T' }, platform)).toEqual({ command: 'reopen-closed-tab' });
    expect(matchTabShortcut({ ...t, [other]: true }, platform)).toBeNull();
    expect(matchTabShortcut({ ...t, [mod]: false, [other]: true }, platform)).toBeNull();
    expect(matchTabShortcut(inputFor('Mod+0', platform), platform)).toBeNull();
    expect(matchTabShortcut(inputFor('Mod+A', platform), platform)).toBeNull();
    expect(matchTabShortcut(inputFor('Mod+C', platform), platform)).toBeNull();
    expect(matchTabShortcut({ ...inputFor('Ctrl+Tab', platform), alt: true }, platform)).toBeNull();
    expect(matchTabShortcut({ ...inputFor('Shift+Tab', platform) }, platform)).toBeNull();
    // Caps Lock: the letter arrives upper-case without Shift; still Mod+T.
    expect(matchTabShortcut({ ...t, key: 'T' }, platform)).toEqual({ command: 'new-tab' });
    // Non-key events (e.g. `char`) never match.
    expect(matchTabShortcut({ ...t, type: 'char' }, platform)).toBeNull();
  });
});

describe('page shortcut matching', () => {
  test.each(PLATFORMS)('page-shortcut-matcher-follows-spec (%s)', (platform) => {
    const mac = platform === 'darwin';
    for (const [command, combos] of Object.entries(RESERVED_PAGE_SHORTCUTS) as [PageCommand, readonly string[]][]) {
      for (const entry of combos) {
        const macOnly = entry.startsWith('mac:');
        const otherOnly = entry.startsWith('other:');
        const combo = entry.replace(/^(mac|other):/, '');
        const match = matchPageShortcut(inputFor(combo, platform), platform);
        if ((macOnly && !mac) || (otherOnly && mac)) {
          expect(match, `${entry} on ${platform}`).toBeNull();
          continue;
        }
        expect(match, entry).toBe(command);
        expect(matchPageShortcut({ ...inputFor(combo, platform), type: 'keyUp' }, platform), `${entry} up`).toBe(command);
        expect(matchPageShortcut({ ...inputFor(combo, platform), type: 'char' }, platform), `${entry} char`).toBeNull();
      }
    }
    // Not reserved: the menu-only and Esc entries, and the tab shortcuts.
    for (const combos of Object.values(UNRESERVED_PAGE_SHORTCUTS)) {
      for (const entry of combos) expect(matchPageShortcut(inputFor(entry.replace(/^(mac|other):/, ''), platform), platform), entry).toBeNull();
    }
    for (const combo of ['Mod+T', 'Mod+W', 'Mod+1', 'Ctrl+Tab']) expect(matchPageShortcut(inputFor(combo, platform), platform), combo).toBeNull();
    // Extra or missing modifiers.
    const mod = mac ? 'meta' : 'control';
    const other = mac ? 'control' : 'meta';
    const r = inputFor('Mod+R', platform);
    expect(matchPageShortcut({ ...r, [mod]: false }, platform)).toBeNull();
    expect(matchPageShortcut({ ...r, alt: true }, platform)).toBeNull();
    expect(matchPageShortcut({ ...r, [other]: true }, platform)).toBeNull();
    expect(matchPageShortcut({ ...inputFor('F5', platform), [mod]: true }, platform)).toBeNull();
    expect(matchPageShortcut({ ...inputFor('F5', platform), shift: true }, platform)).toBeNull();
    expect(matchPageShortcut({ ...inputFor('Mod+0', platform), shift: true }, platform)).toBeNull();
    expect(matchPageShortcut({ ...inputFor('Mod+-', platform), shift: true }, platform)).toBeNull();
    // Alt+arrows only alone (Alt+Shift+Left selects a word in some fields), and never on macOS.
    expect(matchPageShortcut(inputFor('Alt+Shift+Left', platform), platform)).toBeNull();
    expect(matchPageShortcut(inputFor('Alt+Left', platform), platform)).toBe(mac ? null : 'back');
    expect(matchPageShortcut(inputFor('Left', platform), platform)).toBeNull();
    // Mod+[ is back on macOS only (elsewhere Ctrl+[ is not ours).
    expect(matchPageShortcut(inputFor('Mod+[', platform), platform)).toBe(mac ? 'back' : null);
    // Plain letters, digits and Esc.
    for (const combo of ['R', '0', '=', 'Escape', 'Mod+Escape']) expect(matchPageShortcut(inputFor(combo, platform), platform), combo).toBeNull();
  });
});

describe('sidebar shortcut matching', () => {
  test.each(PLATFORMS)('sidebar-shortcut-matches (%s)', (platform) => {
    const toggle = inputFor(SIDEBAR_TOGGLE_SHORTCUT, platform);
    expect(matchSidebarShortcut(toggle, platform)).toBe(true);
    expect(matchSidebarShortcut({ ...toggle, type: 'keyUp' }, platform)).toBe(true);
    // Caps Lock / layouts: the physical key decides.
    expect(matchSidebarShortcut({ ...toggle, key: 'S' }, platform)).toBe(true);
    expect(matchSidebarShortcut({ ...toggle, type: 'char' }, platform)).toBe(false);
    expect(matchSidebarShortcut(inputFor('Mod+S', platform), platform)).toBe(false);
    expect(matchSidebarShortcut({ ...toggle, alt: true }, platform)).toBe(false);
    expect(matchSidebarShortcut({ ...toggle, control: true, meta: true }, platform)).toBe(false);
    expect(matchSidebarShortcut(inputFor('Mod+Shift+D', platform), platform)).toBe(false);
    // The other modifier is not Mod.
    const mac = platform === 'darwin';
    expect(matchSidebarShortcut({ ...toggle, meta: !mac, control: mac }, platform)).toBe(false);
    // Not a tab or page shortcut (it never runs twice).
    expect(matchTabShortcut(toggle, platform)).toBeNull();
    expect(matchPageShortcut(toggle, platform)).toBeNull();
  });
});
