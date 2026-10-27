// Spec: specs/seo-speed.feature.md (Licenses) · the injected libraries are used unmodified (Global Constraints)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import webVitalsSource from 'virtual:web-vitals-iife';
import { AXE_SCRIPT } from '../main/seo/a11y';
import { vitalsScript } from '../main/seo/vitals';
import { buildThirdPartyNotices, NOTICE_PACKAGES, NOTICES_FILE, packageDir, tarballUrl } from '../../third-party-notices';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const committed = () => readFileSync(path.join(APP, NOTICES_FILE), 'utf8');
const installed = (name: string, file: string) => readFileSync(path.join(packageDir(name, 'apps/desktop'), file), 'utf8');

describe('third-party notices', () => {
  test('notices-file-is-current', () => {
    // Regenerate with `pnpm --filter @app/desktop notices` when a dependency changes.
    expect(committed()).toBe(buildThirdPartyNotices());
  });

  test('notices-cover-the-injected-libraries', () => {
    const text = committed();
    // web-vitals: Apache-2.0, its full license text.
    const vitals = installed('web-vitals', 'LICENSE').trimEnd();
    expect(vitals).toContain('END OF TERMS AND CONDITIONS');
    expect(text).toContain(vitals);
    expect(text).toMatch(/web-vitals \d+\.\d+\.\d+\n=+\nLicense: Apache-2\.0/);
    // axe-core: MPL-2.0, its notice, where its source is, its license and third-party notices.
    const axeVersion = (JSON.parse(installed('axe-core', 'package.json')) as { version: string }).version;
    expect(text).toContain('axe-core is subject to the terms of the Mozilla Public License, v. 2.0');
    expect(text).toContain(`Package source: ${tarballUrl('axe-core', axeVersion)}`);
    expect(text).toContain('Repository: https://github.com/dequelabs/axe-core');
    expect(text).toContain(installed('axe-core', 'LICENSE').trimEnd());
    expect(text).toContain(installed('axe-core', 'LICENSE-3RD-PARTY.txt').replace(/\r\n/g, '\n').trimEnd());
    // The other bundled runtime packages too.
    for (const pkg of NOTICE_PACKAGES) expect(text, pkg.name).toMatch(new RegExp(`\\n${pkg.name.replace('/', '\\/')} \\d`));
    expect(tarballUrl('@trpc/client', '11.19.0')).toBe('https://registry.npmjs.org/@trpc/client/-/client-11.19.0.tgz');
  });

  test('injected-libraries-are-unmodified', () => {
    // axe-core: the script starts with the exact bytes of the published axe.min.js.
    const axe = readFileSync(path.join(packageDir('axe-core', 'apps/desktop'), 'axe.min.js'), 'utf8');
    expect(AXE_SCRIPT.startsWith(axe)).toBe(true);
    expect(AXE_SCRIPT.slice(axe.length)).toBe('\n;void 0;');
    // web-vitals: the published IIFE, only its source-map comment dropped.
    const iife = readFileSync(path.join(packageDir('web-vitals', 'apps/desktop'), 'dist/web-vitals.iife.js'), 'utf8');
    expect(webVitalsSource).toBe(iife.replace(/\n\/\/# sourceMappingURL=\S*\s*$/, '\n'));
    expect(vitalsScript()).toContain(webVitalsSource);
  });
});
