import type { HreflangEntry, HttpReport, IndexabilityReport, RobotsAgentVerdict, RobotsReport } from '@app/seo-core';
import { ROBOTS_OUTCOME_LABELS, type IndexabilityVerdict } from '@app/specs/seo-indexability.spec';
import { formatCount } from './seo-view';

// Pure helpers behind the Indexability panel (acceptance `seo-indexability.feature.md`, Panel):
// frost's own labels for statuses, sources, robots.txt verdicts and hreflang flags. Every value
// they take from the audit is rendered as text by the panel.

export type Tone = 'ok' | 'warn' | 'error' | 'muted';

/** Reason phrases for the statuses a page commonly answers with (anything else shows the code alone). */
const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  410: 'Gone',
  429: 'Too Many Requests',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** `404 Not Found`, `599`, or `Unknown`. */
export function statusText(status: number | null): string {
  if (status === null) return 'Unknown';
  const reason = REASONS[status];
  return reason ? `${status} ${reason}` : String(status);
}

/** How a final status reads: 2xx ok, 3xx warn, 4xx/5xx error, unknown muted. */
export function statusTone(status: number | null): Tone {
  if (status === null) return 'muted';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'warn';
  return 'error';
}

/** What the panel says about where the response metadata came from (`RESPONSE_SOURCES`); `null` for a plain network response. */
export function sourceNote(http: HttpReport): string | null {
  switch (http.source) {
    case 'cache':
      return 'Served from the browser cache: the status and headers are the cached response’s.';
    case 'navigation':
      return 'Headers unavailable: this page came from the back/forward cache or memory, so frost saw no response. The status is the one the browser kept. Reload to see the headers.';
    case 'in-page':
      return 'The address changed inside the page (no new document was loaded), so this URL has no response of its own. Reload to fetch it.';
    default:
      return null;
  }
}

/** A size in bytes as `512 B`, `12.3 KB`, `500 KB` (1 KB = 1,000 bytes), for robots.txt sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${formatCount(bytes)} B`;
  const kb = bytes / 1_000;
  return `${kb >= 100 ? formatCount(Math.round(kb)) : (Math.round(kb * 10) / 10).toLocaleString('en-US')} KB`;
}

/** A crawler's robots.txt verdict as a word and a tone. */
export function robotsVerdictLabel(verdict: Pick<RobotsAgentVerdict, 'allowed'>): { label: string; tone: Tone } {
  if (verdict.allowed === true) return { label: 'Allowed', tone: 'ok' };
  if (verdict.allowed === false) return { label: 'Blocked', tone: 'error' };
  return { label: 'Unknown', tone: 'warn' };
}

/** Which rule decided (`Line 4 · Disallow: /x`), or why none did. */
export function robotsRuleText(verdict: RobotsAgentVerdict, robots: Pick<RobotsReport, 'outcome'>): string {
  if (verdict.rule) return `Line ${formatCount(verdict.rule.line)} · ${verdict.rule.allow ? 'Allow' : 'Disallow'}: ${verdict.rule.raw}`;
  if (robots.outcome === 'unavailable') return 'No robots.txt: everything may be crawled';
  if (robots.outcome !== 'ok') return 'robots.txt could not be read: crawlers assume everything is blocked';
  if (verdict.groupAgents.length === 0) return 'No group applies: everything may be crawled';
  return 'No rule matches this URL';
}

/** Which group a crawler follows (`User-agent: *`), or that it follows none. */
export function robotsGroupText(verdict: RobotsAgentVerdict): string {
  if (verdict.groupAgents.length === 0) return 'No group';
  const agents = verdict.groupAgents.length > 3 ? [...verdict.groupAgents.slice(0, 3), `+${verdict.groupAgents.length - 3}`] : verdict.groupAgents;
  return `User-agent: ${agents.join(', ')}${verdict.fallback ? ' (fallback)' : ''}`;
}

/** The robots.txt fetch in one line: `Fetched · 200 · 1.2 KB · 1 redirect`. */
export function robotsFetchText(robots: RobotsReport): string {
  const parts: string[] = [ROBOTS_OUTCOME_LABELS[robots.outcome]];
  if (robots.status !== null) parts.push(String(robots.status));
  if (robots.outcome === 'ok') parts.push(formatBytes(robots.bytes) + (robots.truncated ? ' (cut at the limit)' : ''));
  if (robots.redirects > 0) parts.push(`${formatCount(robots.redirects)} ${robots.redirects === 1 ? 'redirect' : 'redirects'}`);
  return parts.join(' · ');
}

/** The flags an hreflang row shows, in order. */
export function hreflangFlags(entry: HreflangEntry): { flag: string; label: string; tone: Tone }[] {
  const flags: { flag: string; label: string; tone: Tone }[] = [];
  if (!entry.valid) flags.push({ flag: 'invalid', label: 'Invalid code', tone: 'error' });
  if (entry.duplicate) flags.push({ flag: 'duplicate', label: 'Duplicate', tone: 'warn' });
  if (entry.relative) flags.push({ flag: 'relative', label: 'Relative URL', tone: 'warn' });
  if (entry.self) flags.push({ flag: 'self', label: 'This page', tone: 'ok' });
  if (entry.source === 'header') flags.push({ flag: 'header', label: 'HTTP header', tone: 'muted' });
  return flags;
}

/** One signal on the verdict card. */
export interface Signal {
  readonly id: 'http' | 'meta' | 'header' | 'robots' | 'canonical';
  readonly label: string;
  readonly value: string;
  readonly tone: Tone;
}

const NOINDEX = ['noindex', 'none'];

/** The verdict card's five signals: status, robots meta, X-Robots-Tag, robots.txt for Googlebot, canonical. */
export function verdictSignals(report: IndexabilityReport): Signal[] {
  const http = report.http;
  const metaNoindex = report.robotsMeta.some((meta) => meta.content.split(/[\s,]+/).some((token) => NOINDEX.includes(token)));
  const headerNoindex = report.xRobotsTag.some((tag) => tag.directives.some((d) => NOINDEX.includes(d)));
  const googlebot = report.robots?.agents.find((agent) => agent.agent === 'Googlebot');
  const canonical = report.canonical;
  return [
    { id: 'http', label: 'HTTP', value: http ? (http.status === null ? 'Unknown' : String(http.status)) : 'Not seen', tone: http ? statusTone(http.status) : 'muted' },
    { id: 'meta', label: 'Meta robots', value: metaNoindex ? 'noindex' : report.robotsMeta.length > 0 ? 'index' : 'None', tone: metaNoindex ? 'error' : 'ok' },
    {
      id: 'header',
      label: 'X-Robots-Tag',
      value: !http?.headersAvailable ? 'Unknown' : headerNoindex ? 'noindex' : report.xRobotsTag.length > 0 ? 'index' : 'None',
      tone: !http?.headersAvailable ? 'muted' : headerNoindex ? 'error' : 'ok',
    },
    {
      id: 'robots',
      label: 'robots.txt',
      value: googlebot ? robotsVerdictLabel(googlebot).label : 'Not checked',
      tone: googlebot ? robotsVerdictLabel(googlebot).tone : 'muted',
    },
    {
      id: 'canonical',
      label: 'Canonical',
      value: canonical.effective === null ? 'None' : canonical.conflict ? 'Conflict' : canonical.elsewhere ? 'Elsewhere' : 'Self',
      tone: canonical.effective === null ? 'muted' : canonical.conflict ? 'warn' : canonical.elsewhere ? 'warn' : 'ok',
    },
  ];
}

/** The verdict card's headline under the label. */
export function verdictSummary(verdict: IndexabilityVerdict): string {
  switch (verdict) {
    case 'not-indexable':
      return 'Search engines will not show this page in results:';
    case 'canonicalised':
      return 'It can be indexed, but asks search engines to index another URL instead:';
    default:
      return 'Nothing here keeps search engines from indexing this page.';
  }
}
