import { domainToUnicode } from 'node:url';

// A tab's page title as the strip should see it (spec `TabStateSchema.title`, `tabs.feature.md`).
// For a page without a <title>, Chromium's `webContents.getTitle()` (and the navigation entry's
// title) is not empty but a display form of the URL: scheme, a leading `www.` and a bare root `/`
// dropped, escapes decoded, the host in Unicode (`https://www.example.com/` → `example.com`,
// `http://127.0.0.1:8080/a?q=%20b` → `127.0.0.1:8080/a?q= b`). That is not a title; the strip falls
// back to the host instead (`tabLabel`).

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The URL as Chromium displays it in place of a missing title (compared loosely, see `pageTitle`). */
function urlTitleForms(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const tail = rest === '/' ? '' : rest;
  const forms = new Set<string>([url, decode(url)]);
  for (const hostname of [parsed.hostname, domainToUnicode(parsed.hostname)]) {
    for (const host of [hostname, hostname.replace(/^www\./, '')]) {
      const withPort = parsed.port === '' ? host : `${host}:${parsed.port}`;
      forms.add(`${withPort}${tail}`);
      forms.add(decode(`${withPort}${tail}`));
    }
  }
  return [...forms];
}

/**
 * `title` (from `webContents.getTitle()`) for the page at `url`, or `''` when it is Chromium's
 * URL-derived stand-in for a missing <title>. A page whose real title equals its own URL loses it
 * too; the strip then shows the host, which says the same.
 */
export function pageTitle(title: string, url: string): string {
  if (title === '' || url === '') return title;
  return urlTitleForms(url).includes(title) ? '' : title;
}
