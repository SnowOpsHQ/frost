// Acceptance: specs/tabs.feature.md (Renderer: tablist-keys-move-focus)
import { describe, expect, test } from 'vitest';
import { tablistFocusTarget } from '../tablist-keys';

describe('tablist keys', () => {
  test('tablist-keys-move-focus', () => {
    expect(tablistFocusTarget('ArrowRight', 0, 3)).toBe(1);
    expect(tablistFocusTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tablistFocusTarget('ArrowLeft', 1, 3)).toBe(0);
    expect(tablistFocusTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tablistFocusTarget('Home', 2, 3)).toBe(0);
    expect(tablistFocusTarget('End', 0, 3)).toBe(2);
    expect(tablistFocusTarget('ArrowRight', 0, 1)).toBe(0);
    for (const key of ['Enter', ' ', 'ArrowUp', 'Delete', 'a']) expect(tablistFocusTarget(key, 1, 3), key).toBeNull();
    expect(tablistFocusTarget('ArrowRight', 0, 0)).toBeNull();
  });
});
