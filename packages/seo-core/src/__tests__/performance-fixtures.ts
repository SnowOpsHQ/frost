import type { NavigationTiming, PerformanceMeasurement, ResourceRecord } from '../index';
import { PAGE_URL } from './fixtures';

// Measurement fixtures for the speed tests (`seo-speed.feature.md`): a fast, small page that passes
// every `performance` rule, and helpers to change it the way a scenario says.

export function navigation(changes: Partial<NavigationTiming> = {}): NavigationTiming {
  return {
    type: 'navigate',
    redirectCount: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: 1,
    domainLookupStart: 2,
    domainLookupEnd: 12,
    connectStart: 12,
    secureConnectionStart: 20,
    connectEnd: 40,
    requestStart: 41,
    responseStart: 120,
    responseEnd: 140,
    domInteractive: 300,
    domContentLoadedEventEnd: 320,
    loadEventEnd: 600,
    activationStart: 0,
    transfer: 12_300,
    encoded: 12_000,
    decoded: 48_000,
    contentType: 'text/html',
    contentEncoding: 'br',
    ...changes,
  };
}

export function resource(changes: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    url: 'https://example.com/app.js',
    urlCut: false,
    initiator: 'script',
    contentType: 'text/javascript',
    contentEncoding: 'gzip',
    transfer: 20_300,
    encoded: 20_000,
    decoded: 80_000,
    start: 150,
    duration: 60,
    blocking: false,
    ...changes,
  };
}

export function measurement(changes: Partial<PerformanceMeasurement> = {}): PerformanceMeasurement {
  return {
    url: PAGE_URL,
    measuredAt: 1_760_000_000_000,
    durationMs: 3,
    vitals: { lcp: 1_200, cls: 0.02, inp: null, fcp: 900, ttfb: 120 },
    loadedHidden: false,
    navigation: navigation(),
    resources: [
      resource(),
      resource({ url: 'https://example.com/site.css', initiator: 'link', contentType: 'text/css', transfer: 8_300, encoded: 8_000, decoded: 30_000, blocking: true }),
      resource({ url: 'https://example.com/hero.webp', initiator: 'img', contentType: 'image/webp', contentEncoding: '', transfer: 90_300, encoded: 90_000, decoded: 90_000 }),
    ],
    resourceTotal: 3,
    overflow: { transfer: 0, encoded: 0, decoded: 0, weight: 0 },
    bufferFull: false,
    dom: { elements: 400, depth: 12, depthComplete: true },
    ...changes,
  };
}

/** The measurement with these vitals changed. */
export function withVitals(vitals: Partial<PerformanceMeasurement['vitals']>, changes: Partial<PerformanceMeasurement> = {}): PerformanceMeasurement {
  const base = measurement(changes);
  return { ...base, vitals: { ...base.vitals, ...vitals } };
}
