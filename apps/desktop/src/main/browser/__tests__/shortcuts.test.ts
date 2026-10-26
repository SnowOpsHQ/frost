// Spec: specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS) · Acceptance: specs/tabs.feature.md (Shortcut matching)
import { describe, expect, test } from 'vitest';
import { RESERVED_TAB_SHORTCUTS, type TabCommand } from '@app/specs/tabs.spec';
import { matchTabShortcut, type KeyInput } from '../shortcuts';

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
    else throw new Error(`unknown modifier ${modifier}`);
  }
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
    expect(matchTabShortcut({ ...t, shift: true, key: 'T' }, platform)).toBeNull();
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
