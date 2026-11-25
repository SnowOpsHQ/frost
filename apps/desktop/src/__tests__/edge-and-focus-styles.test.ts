// Spec: specs/design-tokens.spec.ts (the --e-ring and --focus-ring tokens)
// Acceptance: specs/design-tokens.feature.md (ring-edges-keep-a-forced-colours-border, agent-focus-shows-the-ring, agent-pressed-tool-holds-on-hover)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../renderer/${relative}`, import.meta.url)), 'utf8');

/** The declarations of every top-level rule whose selector (or one of its list) is exactly `selector` in `file`, comments stripped. */
function rule(file: string, selector: string): string {
  const plain = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1]!.split(',').some((part) => part.trim() === selector));
  expect(found.length, `${file}: ${selector}`).toBeGreaterThan(0);
  return found.map((match) => match[2]!).join('\n');
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

test('agent-focus-shows-the-ring', () => {
  for (const selector of ['.agent-attach-option:focus-visible', '.agent-code:focus-visible', '.agent-pre:focus-visible']) {
    const body = rule('components/agent/agent.css', selector);
    expect(body, `${selector} shows --focus-ring`).toContain('box-shadow: var(--focus-ring);');
    // The transparent outline is what forced colours draw (they drop the shadow) and replaces the browser's own.
    expect(body, `${selector} has the transparent outline`).toMatch(/outline:\s*2px solid transparent;/);
    expect(body, `${selector} offsets it`).toMatch(/outline-offset:\s*2px;/);
  }
});

/** A compound selector's weight as [ids, classes + attributes + pseudo-classes, types]; `:where()` weighs nothing. */
function weight(selector: string): [number, number, number] {
  const plain = selector.replace(/:where\([^)]*\)/g, '');
  const count = (pattern: RegExp) => plain.match(pattern)?.length ?? 0;
  return [count(/#[\w-]+/g), count(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g), 0];
}

test('agent-pressed-tool-holds-on-hover', () => {
  const pressed = ".tool.agent-head-tool[aria-pressed='true']";
  const agent = read('components/agent/agent.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selector = [...agent.matchAll(/([^{}]+)\{[^{}]*accent-soft[^{}]*\}/g)].map((match) => match[1]!.trim()).find((name) => name.includes('agent-head-tool') && name.includes('aria-pressed'));
  expect(selector, 'the pressed agent-head tool keeps a pressed rule').toBeDefined();
  // The hover is the chrome's `.tool:hover`; the agent's sheet loads before styles.css, so a tie goes to it.
  const hover = weight('.tool:hover:where(:not(:disabled))');
  expect(hover).toEqual([0, 2, 0]);
  const [ids, classes] = weight(selector!);
  expect(ids > hover[0] || (ids === hover[0] && classes > hover[1]), `${selector} outweighs .tool:hover`).toBe(true);
  expect(selector).toBe(pressed);
});
