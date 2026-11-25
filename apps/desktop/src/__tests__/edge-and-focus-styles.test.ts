// Spec: specs/design-tokens.spec.ts (the --e-ring and --focus-ring tokens)
// Acceptance: specs/design-tokens.feature.md (ring-edges-keep-a-forced-colours-border)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../renderer/${relative}`, import.meta.url)), 'utf8');

/** The declarations of the top-level rule whose selector is exactly `selector` in `file`, comments stripped. */
function rule(file: string, selector: string): string {
  const plain = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => match[1]!.trim() === selector);
  expect(found, `${file}: ${selector}`).toBeDefined();
  return found![2]!;
}

test('ring-edges-keep-a-forced-colours-border', () => {
  for (const [file, selector] of [['styles.css', '.palette'], ['styles.css', '.palette-kbd'], ['help.css', '.help-kbd']] as const) {
    const body = rule(file, selector);
    // --e-ring is a shadow, which forced colours drop: the transparent border is the edge they draw.
    expect(body, `${selector} draws --e-ring`).toContain('box-shadow: var(--e-ring);');
    expect(body, `${selector} has a transparent 1px border`).toMatch(/border:\s*1px solid transparent;/);
  }
  // The border takes 1px a side from the hints' padding, so their boxes stay the size they were.
  expect(rule('styles.css', '.palette-kbd')).toMatch(/padding:\s*0 calc\(var\(--space-2\) - 1px\);/);
  expect(rule('help.css', '.help-kbd')).toMatch(/padding:\s*0 calc\(var\(--space-2\) - 1px\);/);
});
