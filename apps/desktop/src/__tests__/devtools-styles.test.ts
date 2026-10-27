// Spec: specs/devtools.spec.ts (DEVTOOLS_HEIGHT.pageMinVisible)
// Acceptance: specs/devtools.feature.md (devtools-styles-are-delimited)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { DEVTOOLS_HEIGHT } from '@app/specs/devtools.spec';

const CSS = readFileSync(fileURLToPath(new URL('../renderer/styles.css', import.meta.url)), 'utf8');
const COMPONENTS = fileURLToPath(new URL('../renderer/components/devtools/', import.meta.url));

test('devtools-styles-are-delimited', () => {
  // One delimited section, at the end of the stylesheet; every `.devtools` rule lives in it.
  const start = CSS.indexOf('/* Devtools drawer ');
  const end = CSS.indexOf('/* End of Devtools drawer */');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(CSS.indexOf('/* Devtools drawer ', start + 1)).toBe(-1);
  const outside = CSS.slice(0, start) + CSS.slice(end);
  expect(outside).not.toMatch(/\.devtools[-\s{,:]/);
  // The page keeps the spec's minimum in view.
  expect(CSS.slice(start, end)).toContain(`--devtools-page-min: ${DEVTOOLS_HEIGHT.pageMinVisible}px;`);
  // Strict CSP: no inline style anywhere in the drawer's components.
  const files = readdirSync(COMPONENTS).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'));
  expect(files.length).toBeGreaterThanOrEqual(6);
  for (const name of files) {
    const source = readFileSync(`${COMPONENTS}${name}`, 'utf8');
    expect(source, name).not.toMatch(/\bstyle=[{"']|\.style\b|setAttribute\(\s*['"]style|dangerouslySetInnerHTML|innerHTML/);
  }
});
