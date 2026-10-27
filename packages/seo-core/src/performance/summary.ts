import { CORE_WEB_VITALS, RESOURCE_TYPES, SPEED_PANEL_LIMITS, VITAL_BANDS, VITAL_METRICS, VITAL_THRESHOLDS, type ResourceType, type VitalBand, type VitalMetric } from '@app/specs/seo-speed.spec';
import { fromCache, hostOf, isThirdParty, isUncompressedText, resourceType, sizeUnavailable, weightOf } from './classify';
import type { HostShare, LargeResource, NavigationPhase, NavigationReport, NavigationSpan, NavigationTiming, PerformanceMeasurement, ResourceBreakdown, ResourceRecord, SpeedSummary, UncompressedResource, VitalReading } from './model';

// Summarising a validated measurement (acceptance `seo-speed.feature.md`, Summary). Pure and linear
// in the measurement's (capped) size; runs in the analysis worker.

/** The band of `value` for `metric` (`VITAL_THRESHOLDS`): at most `good` is good, above `poor` poor. */
export function vitalBand(metric: VitalMetric, value: number): VitalBand {
  const { good, poor } = VITAL_THRESHOLDS[metric];
  if (value <= good) return 'good';
  return value > poor ? 'poor' : 'needs-improvement';
}

/** The worse of two bands. */
function worse(a: VitalBand | null, b: VitalBand): VitalBand {
  return a === null || VITAL_BANDS.indexOf(b) > VITAL_BANDS.indexOf(a) ? b : a;
}

/** The document's navigation entry as a record of its own (it is a request too: type `document`). */
function documentRecord(url: string, nav: NavigationTiming): ResourceRecord {
  return {
    url,
    urlCut: false,
    initiator: 'navigation',
    contentType: nav.contentType,
    contentEncoding: nav.contentEncoding,
    transfer: nav.transfer,
    encoded: nav.encoded,
    decoded: nav.decoded,
    start: 0,
    duration: nav.responseEnd,
    blocking: null,
  };
}

/** The document's request as phases and milestones. */
export function navigationReport(nav: NavigationTiming): NavigationReport {
  const spans: NavigationSpan[] = [];
  const span = (phase: NavigationPhase, start: number, end: number): void => {
    if (end > start) spans.push({ phase, start, end });
  };
  if (nav.redirectCount > 0) span('redirect', nav.redirectStart, nav.redirectEnd);
  span('dns', nav.domainLookupStart, nav.domainLookupEnd);
  const tls = nav.secureConnectionStart > 0 && nav.connectEnd > nav.secureConnectionStart;
  span('connect', nav.connectStart, tls ? nav.secureConnectionStart : nav.connectEnd);
  if (tls) span('tls', nav.secureConnectionStart, nav.connectEnd);
  if (nav.requestStart > 0) span('request', nav.requestStart, nav.responseStart);
  span('response', nav.responseStart, nav.responseEnd);
  const durations = { redirect: 0, dns: 0, connect: 0, tls: 0, request: 0, response: 0 } as Record<NavigationPhase, number>;
  for (const s of spans) durations[s.phase] = s.end - s.start;
  const reached = (t: number) => (t > 0 ? t : null);
  return {
    type: nav.type,
    redirectCount: nav.redirectCount,
    spans,
    durations,
    ttfb: Math.max(0, nav.responseStart - nav.activationStart),
    domInteractive: reached(nav.domInteractive),
    domContentLoaded: reached(nav.domContentLoadedEventEnd),
    load: reached(nav.loadEventEnd),
  };
}

/** `m` summarised for the panel and the rules. */
export function summariseSpeed(m: PerformanceMeasurement): SpeedSummary {
  const vitals: VitalReading[] = VITAL_METRICS.map((metric) => {
    const value = m.vitals[metric];
    return { metric, value, band: value === null ? null : vitalBand(metric, value) };
  });
  let verdict: VitalBand | null = null;
  for (const reading of vitals) if (reading.band !== null && (CORE_WEB_VITALS as readonly VitalMetric[]).includes(reading.metric)) verdict = worse(verdict, reading.band);

  const records: ResourceRecord[] = m.navigation ? [documentRecord(m.url, m.navigation), ...m.resources] : [...m.resources];
  const pageHost = hostOf(m.url);
  const byType = new Map<ResourceType, { requests: number; transfer: number; decoded: number; weight: number; unavailable: number }>(RESOURCE_TYPES.map((type) => [type, { requests: 0, transfer: 0, decoded: 0, weight: 0, unavailable: 0 }]));
  const hosts = new Map<string, { requests: number; weight: number; thirdParty: boolean }>();
  const largest: LargeResource[] = [];
  const uncompressed: UncompressedResource[] = [];
  let transfer = m.overflow.transfer;
  let decoded = m.overflow.decoded;
  let weight = m.overflow.weight;
  let unavailable = 0;
  let cached = 0;
  let thirdRequests = 0;
  let thirdWeight = 0;
  for (const record of records) {
    const type = resourceType(record);
    const w = weightOf(record);
    const none = sizeUnavailable(record);
    const bucket = byType.get(type)!;
    bucket.requests += 1;
    bucket.transfer += record.transfer;
    bucket.decoded += record.decoded;
    bucket.weight += w;
    if (none) {
      bucket.unavailable += 1;
      unavailable += 1;
    }
    transfer += record.transfer;
    decoded += record.decoded;
    weight += w;
    const isCached = fromCache(record);
    if (isCached) cached += 1;
    const host = hostOf(record.url);
    const third = isThirdParty(host, pageHost);
    if (third) {
      thirdRequests += 1;
      thirdWeight += w;
    }
    const share = hosts.get(host);
    if (share) {
      share.requests += 1;
      share.weight += w;
    } else hosts.set(host, { requests: 1, weight: w, thirdParty: third });
    if (w > 0) largest.push({ url: record.url, urlCut: record.urlCut, type, weight: w, transfer: record.transfer, decoded: record.decoded, duration: record.duration, cached: isCached, thirdParty: third });
    if (isUncompressedText(record, type)) uncompressed.push({ url: record.url, urlCut: record.urlCut, type, decoded: record.decoded });
  }
  largest.sort((a, b) => b.weight - a.weight);
  uncompressed.sort((a, b) => b.decoded - a.decoded);
  const hostList: HostShare[] = [...hosts].map(([host, share]) => ({ host, ...share }));
  hostList.sort((a, b) => b.weight - a.weight || b.requests - a.requests);

  const breakdown: ResourceBreakdown[] = RESOURCE_TYPES.map((type) => ({ type, ...byType.get(type)! }));
  const notItemised = m.resourceTotal - m.resources.length;
  return {
    url: m.url,
    measuredAt: m.measuredAt,
    vitals,
    verdict,
    loadedHidden: m.loadedHidden,
    requests: { total: records.length + notItemised, itemised: records.length, notItemised, transfer, decoded, weight, unavailable, cached },
    byType: breakdown,
    largest: largest.slice(0, SPEED_PANEL_LIMITS.largest),
    uncompressed: uncompressed.slice(0, SPEED_PANEL_LIMITS.uncompressed),
    uncompressedTotal: uncompressed.length,
    thirdParty: { requests: thirdRequests, weight: thirdWeight, hosts: hostList.slice(0, SPEED_PANEL_LIMITS.hosts), hostTotal: hostList.length },
    dom: { ...m.dom },
    navigation: m.navigation ? navigationReport(m.navigation) : null,
    bufferFull: m.bufferFull,
  };
}
