// Spec: specs/seo-limits.spec.ts (SEO_WORLD_ID, SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS)
// Acceptance: specs/seo-sidebar.feature.md (Extraction)
import { describe, expect, test, vi } from 'vitest';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SEO_WORLD_ID, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { EXTRACTOR_SCRIPT, runExtractor } from '../extract';

describe('extractor', () => {
  test('extractor-runs-in-seo-world', async () => {
    const answer = { url: 'https://example.com/' };
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => answer) };
    await expect(runExtractor(contents)).resolves.toBe(answer);
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    const [world, scripts, ...rest] = contents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
    expect(world).toBe(SEO_WORLD_ID);
    expect(world).not.toBe(0);
    expect(world).not.toBe(999);
    expect(scripts).toEqual([{ code: EXTRACTOR_SCRIPT }]);
    // No user gesture is claimed.
    expect(rest).toEqual([]);
  });

  test('extractor-source-is-self-contained', () => {
    expect(typeof EXTRACTOR_SCRIPT).toBe('string');
    // It parses as a script (an expression statement calling the extractor).
    expect(() => new Function(EXTRACTOR_SCRIPT)).not.toThrow();
    expect(EXTRACTOR_SCRIPT).toContain(JSON.stringify(SNAPSHOT_LIMITS));
    expect(EXTRACTOR_SCRIPT).toContain(`, ${EXTRACT_BUDGET_MS}, ${JSON.stringify(ROBOTS_META_NAMES)})`);
    // Reads only; never writes the DOM, never uses Node or Electron, never reads innerText / innerHTML.
    for (const forbidden of [/\brequire\s*\(/, /\bprocess\./, /\belectron\b/i, /\bipcRenderer\b/, /\binnerText\b/, /\binnerHTML\b/, /\bouterHTML\b/, /\.(appendChild|insertBefore|removeChild|replaceChildren|setAttribute|remove)\(/, /\beval\s*\(/]) {
      expect(EXTRACTOR_SCRIPT, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
