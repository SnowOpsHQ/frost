// Spec: specs/command-palette.spec.ts (keyboard), specs/tabs.spec.ts / specs/page-commands.spec.ts (shortcut notation)
// Acceptance: specs/command-palette.feature.md (Built-in actions: palette-keys, shortcut-labels-per-platform;
// Registry, matcher and recents: selection-follows-the-action-id)
import { describe, expect, test } from 'vitest';
import { PALETTE_PAGE_STEP, paletteKey, resolveActive, shortcutLabel } from '../keys';

const press = (key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('palette keys', () => {
  test('palette-keys', () => {
    expect(paletteKey(press('ArrowDown'), 0, 5)).toEqual({ type: 'move', index: 1 });
    expect(paletteKey(press('ArrowDown'), 4, 5)).toEqual({ type: 'move', index: 0 });
    expect(paletteKey(press('ArrowUp'), 0, 5)).toEqual({ type: 'move', index: 4 });
    expect(paletteKey(press('ArrowUp'), 3, 5)).toEqual({ type: 'move', index: 2 });
    expect(paletteKey(press('Tab'), 4, 5)).toEqual({ type: 'move', index: 0 });
    expect(paletteKey(press('Tab', { shiftKey: true }), 0, 5)).toEqual({ type: 'move', index: 4 });
    expect(paletteKey(press('PageDown'), 0, 20)).toEqual({ type: 'move', index: PALETTE_PAGE_STEP });
    expect(paletteKey(press('PageDown'), 18, 20)).toEqual({ type: 'move', index: 19 });
    expect(paletteKey(press('PageUp'), 3, 20)).toEqual({ type: 'move', index: 0 });
    expect(paletteKey(press('Enter'), 2, 5)).toEqual({ type: 'run' });
    expect(paletteKey(press('Escape'), 2, 5)).toEqual({ type: 'close' });
    // Nothing listed: moves and Enter do nothing, Esc still closes; Tab stays in the palette.
    expect(paletteKey(press('ArrowDown'), -1, 0)).toEqual({ type: 'none' });
    expect(paletteKey(press('Tab'), -1, 0)).toEqual({ type: 'none' });
    expect(paletteKey(press('Enter'), -1, 0)).toEqual({ type: 'none' });
    expect(paletteKey(press('Escape'), -1, 0)).toEqual({ type: 'close' });
    // The search box's own keys pass through (null: not handled).
    for (const key of ['a', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']) expect(paletteKey(press(key), 0, 5), key).toBeNull();
    // With a modifier (IME, selection, OS shortcuts) arrows and Enter are left alone.
    expect(paletteKey(press('ArrowDown', { altKey: true }), 0, 5)).toBeNull();
    expect(paletteKey(press('Enter', { ctrlKey: true }), 0, 5)).toBeNull();
  });

  test('shortcut-labels-per-platform', () => {
    expect(shortcutLabel('Mod+Shift+R', true)).toBe('⇧⌘R');
    expect(shortcutLabel('Mod+Shift+R', false)).toBe('Ctrl+Shift+R');
    expect(shortcutLabel('Mod+T', true)).toBe('⌘T');
    expect(shortcutLabel('Mod+T', false)).toBe('Ctrl+T');
    expect(shortcutLabel('Ctrl+Tab', true)).toBe('⌃Tab');
    expect(shortcutLabel('Ctrl+Shift+Tab', false)).toBe('Ctrl+Shift+Tab');
    expect(shortcutLabel('Alt+Left', false)).toBe('Alt+←');
    expect(shortcutLabel('Mod+[', true)).toBe('⌘[');
    expect(shortcutLabel('Mod+=', false)).toBe('Ctrl+=');
    expect(shortcutLabel({ mac: 'Mod+[', other: 'Alt+Left' }, true)).toBe('⌘[');
    expect(shortcutLabel({ mac: 'Mod+[', other: 'Alt+Left' }, false)).toBe('Alt+←');
  });

  test('selection-follows-the-action-id', () => {
    const before = ['page.reload', 'page.zoom-in', 'page.zoom-out'];
    expect(resolveActive(before, 'page.zoom-in')).toBe(1);
    // The page adds "Go back" above it: the selection moves with the action, not the row.
    const after = ['page.reload', 'page.back', 'page.zoom-in', 'page.zoom-out'];
    expect(resolveActive(after, 'page.zoom-in')).toBe(2);
    // The selected action went away: the first row.
    expect(resolveActive(['page.reload', 'page.zoom-out'], 'page.zoom-in')).toBe(0);
    // No selection yet: the first row; an empty list: none.
    expect(resolveActive(after, null)).toBe(0);
    expect(resolveActive([], 'page.zoom-in')).toBe(-1);
    expect(resolveActive([], null)).toBe(-1);
  });
});
