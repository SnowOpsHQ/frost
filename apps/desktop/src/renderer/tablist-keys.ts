// Keyboard focus movement inside the tab strip's tablist (spec `tabs.feature.md`, Accessible
// structure): Left/Right to the previous/next tab, wrapping; Home/End to the first/last.

/** The index to focus after `key` on the tab at `index` of `count`, or `null` if `key` doesn't move focus. */
export function tablistFocusTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
