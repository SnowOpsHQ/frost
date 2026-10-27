import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// THIRD_PARTY_NOTICES (specs/seo-speed.feature.md, Licenses): the licenses of the third-party
// packages bundled into the app, built from the installed packages' own license files. The file is
// committed beside this script and shipped in the packaged app as an extra resource
// (forge.config.ts, `resources/THIRD_PARTY_NOTICES`). A test regenerates it and fails when the
// committed copy is stale; `pnpm --filter @app/desktop notices` rewrites it.
//
// The two libraries injected into web pages come first: web-vitals (Apache-2.0, its full license
// text) and axe-core (MPL-2.0: its notice, where to get its source, and its license and third-party
// notices). Then the other runtime packages bundled into main and the chrome.

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES';

/** The repository root (apps/desktop is two levels down). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface NoticePackage {
  readonly name: string;
  /** Where the package is resolved from (a directory relative to the repository root): the package that depends on it. */
  readonly from: string;
  /** What frost uses it for. */
  readonly use: string;
}

export const NOTICE_PACKAGES: readonly NoticePackage[] = [
  { name: 'web-vitals', from: 'apps/desktop', use: 'Injected, unmodified, into an isolated world of the pages frost measures (the Page Speed panel).' },
  { name: 'axe-core', from: 'apps/desktop', use: 'Injected, unmodified, into an isolated world of the pages frost checks, on request (the Compliance panel).' },
  { name: 'react', from: 'apps/desktop', use: 'The app window’s interface.' },
  { name: 'react-dom', from: 'apps/desktop', use: 'The app window’s interface.' },
  { name: 'scheduler', from: 'node_modules/react-dom', use: 'Used by react-dom.' },
  { name: '@trpc/client', from: 'packages/ipc-contract', use: 'Messages between the app window and the main process.' },
  { name: '@trpc/server', from: 'packages/ipc-contract', use: 'Messages between the app window and the main process.' },
  { name: 'zod', from: 'specs', use: 'Validating messages and page data in the main process.' },
  { name: 'drizzle-orm', from: 'packages/db', use: 'The browser-session database.' },
  { name: 'parse5', from: 'apps/desktop', use: 'Parsing the HTML a server sends, in the analysis worker (the JavaScript panel).' },
  { name: 'entities', from: 'apps/desktop', use: 'Used by parse5.' },
  { name: 'saxes', from: 'apps/desktop', use: 'Reading sitemaps in the analysis worker (streaming, no DTDs; the sitemap check).' },
  { name: 'xmlchars', from: 'node_modules/saxes', use: 'Used by saxes.' },
];

/** The directory of package `name` as Node would find it from `from` (walking up `node_modules`). */
export function packageDir(name: string, from: string, root: string = ROOT): string {
  for (let dir = path.resolve(root, from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`third-party notices: ${name} is not installed (from ${from})`);
  }
}

/** A repository URL as a plain https address (`git+https://…/x.git` → `https://…/x`). */
function plainRepository(repository: unknown): string | null {
  const url = typeof repository === 'string' ? repository : typeof repository === 'object' && repository !== null ? (repository as { url?: unknown }).url : null;
  if (typeof url !== 'string') return null;
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

/** The npm registry tarball of `name@version` (the exact source frost bundles). */
export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

const RULE = '='.repeat(100);

/** The notices file's text: deterministic (no dates), from the installed packages. */
export function buildThirdPartyNotices(packages: readonly NoticePackage[] = NOTICE_PACKAGES, root: string = ROOT): string {
  const parts: string[] = [
    'THIRD-PARTY NOTICES',
    '',
    'frost includes the open-source software listed below. Each package is distributed under its own',
    'license, reproduced here from the package as installed. Electron and Chromium ship their own',
    'license files beside the app (LICENSE, LICENSES.chromium.html).',
    '',
  ];
  for (const pkg of packages) {
    const dir = packageDir(pkg.name, pkg.from, root);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string; license?: string; repository?: unknown; homepage?: string };
    const license = manifest.license ?? 'UNKNOWN';
    const source = plainRepository(manifest.repository) ?? manifest.homepage ?? null;
    parts.push(RULE, `${pkg.name} ${manifest.version}`, RULE, `License: ${license}`, `Used for: ${pkg.use}`, `Package source: ${tarballUrl(pkg.name, manifest.version)}`);
    if (source) parts.push(`Repository: ${source}`);
    if (license === 'MPL-2.0') {
      parts.push(
        '',
        `${pkg.name} is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL`,
        'was not distributed with this file, you can obtain one at https://mozilla.org/MPL/2.0/.',
        `frost uses ${pkg.name} unmodified, as published. Its source code form is available from the package`,
        'source and repository above.',
      );
    }
    const files = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|notice|copying)/i.test(file))
      .sort();
    if (files.length === 0) {
      parts.push('', `The package ships no license file. Its package.json declares ${license}${license === 'Apache-2.0' ? '; the license’s full text is given in the web-vitals section above (its terms and conditions, up to "END OF TERMS AND CONDITIONS")' : ''}.`);
    }
    for (const file of files) parts.push('', `---- ${file} ----`, '', readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd());
    parts.push('');
  }
  return `${parts.join('\n')}\n`;
}

/** Writes the notices file beside this script. */
export function writeThirdPartyNotices(file: string = path.join(ROOT, 'apps/desktop', NOTICES_FILE)): void {
  writeFileSync(file, buildThirdPartyNotices());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeThirdPartyNotices();
