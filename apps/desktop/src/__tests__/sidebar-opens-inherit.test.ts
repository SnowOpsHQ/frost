// Acceptance: specs/render-profile.feature.md (Popups: `sidebar-page-urls-inherit-the-tab-profile`)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SEO = fileURLToPath(new URL('../renderer/components/seo/', import.meta.url));

/** The arguments of each `openBackgroundTab(…).then(` call in a panel's source; every call there has that shape. */
function opens(file: string): string[] {
  const source = readFileSync(`${SEO}${file}`, 'utf8');
  const calls = [...source.matchAll(/openBackgroundTab\((.*?)\)\.then\(/g)].map((match) => match[1]!);
  expect(calls, file).toHaveLength(source.split('openBackgroundTab(').length - 1);
  return calls;
}

test('sidebar-page-urls-inherit-the-tab-profile', () => {
  // A URL the audited page gave (a link, a resource, a script, a structured-data URL) opens with the
  // tab's render profile; frost's own destinations (a rule's help page, robots.txt, a sitemap) do not.
  const own = new Set(['Compliance.tsx', 'Indexability.tsx']);
  const seen = new Map<string, string[]>();
  for (const file of readdirSync(SEO).filter((name) => name.endsWith('.tsx'))) {
    const calls = opens(file);
    if (calls.length > 0) seen.set(file, calls);
  }
  expect([...seen.keys()].sort()).toEqual(['Compliance.tsx', 'Indexability.tsx', 'JavaScript.tsx', 'Schema.tsx', 'Speed.tsx', 'actions.tsx']);
  for (const [file, calls] of seen) {
    for (const call of calls) expect(call.includes('{ inherit: true }'), `${file}: openBackgroundTab(${call})`).toBe(!own.has(file));
  }
});
