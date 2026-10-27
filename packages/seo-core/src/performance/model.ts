import type { ResourceType, SpeedUnavailableReason, VitalBand, VitalMetric } from '@app/specs/seo-speed.spec';
import type { Finding } from '../types';

// What the Speed panel shows (Phase 2 Task 5; acceptance `seo-speed.feature.md`): a measurement
// summarised in the worker (`summariseSpeed`), with the `performance` findings it fails.

export type { NavigationTiming, PerformanceMeasurement, ResourceRecord } from '@app/specs/seo-speed.schema.spec';

/** One metric's value and band (`null` / `null`: not measured). */
export interface VitalReading {
  readonly metric: VitalMetric;
  readonly value: number | null;
  readonly band: VitalBand | null;
}

/** Requests of one type and their bytes (`unavailable`: how many reported no size). */
export interface ResourceBreakdown {
  readonly type: ResourceType;
  readonly requests: number;
  /** Σ transfer sizes (0 for cached and size-unavailable responses). */
  readonly transfer: number;
  /** Σ decoded body sizes. */
  readonly decoded: number;
  /** Σ each request's weight: its transfer size, or its encoded size when it came from the cache. */
  readonly weight: number;
  readonly unavailable: number;
}

/** One of the largest requests (by weight). */
export interface LargeResource {
  readonly url: string;
  /** The URL was cut to `maxResourceUrlChars`: shown, never opened. */
  readonly urlCut: boolean;
  readonly type: ResourceType;
  readonly weight: number;
  readonly transfer: number;
  readonly decoded: number;
  readonly duration: number;
  /** Answered from the cache (no transfer, an encoded size). */
  readonly cached: boolean;
  readonly thirdParty: boolean;
}

/** A text response sent without compression. */
export interface UncompressedResource {
  readonly url: string;
  readonly urlCut: boolean;
  readonly type: ResourceType;
  readonly decoded: number;
}

/** Requests to one host. */
export interface HostShare {
  readonly host: string;
  readonly requests: number;
  readonly weight: number;
  readonly thirdParty: boolean;
}

export const NAVIGATION_PHASES = ['redirect', 'dns', 'connect', 'tls', 'request', 'response'] as const;
export type NavigationPhase = (typeof NAVIGATION_PHASES)[number];

/** A phase of the document's request, as a span of milliseconds since navigation start. */
export interface NavigationSpan {
  readonly phase: NavigationPhase;
  readonly start: number;
  readonly end: number;
}

/** The document's navigation timing, as phases and milestones (ms since navigation start; `null`: not reached yet). */
export interface NavigationReport {
  readonly type: string;
  readonly redirectCount: number;
  /** The phases that happened, in order (a reused connection has no DNS, connect or TLS). */
  readonly spans: readonly NavigationSpan[];
  /** Each phase's length (0 when it did not happen). */
  readonly durations: Readonly<Record<NavigationPhase, number>>;
  readonly ttfb: number;
  readonly domInteractive: number | null;
  readonly domContentLoaded: number | null;
  readonly load: number | null;
}

/** A measurement, summarised. Everything is bounded by `SPEED_LIMITS` and `SPEED_PANEL_LIMITS`. */
export interface SpeedSummary {
  readonly url: string;
  readonly measuredAt: number;
  readonly vitals: readonly VitalReading[];
  /** The worst band of the Core Web Vitals that were measured (`CORE_WEB_VITALS`); `null` when none was. */
  readonly verdict: VitalBand | null;
  readonly loadedHidden: boolean;
  readonly requests: {
    /** Every request observed, the document included. */
    readonly total: number;
    /** Requests itemised by type (the rest are `notItemised`, beyond `maxResources`). */
    readonly itemised: number;
    readonly notItemised: number;
    readonly transfer: number;
    readonly decoded: number;
    /** Page weight (`PAGE_WEIGHT_WARN_BYTES`): Σ each request's weight. */
    readonly weight: number;
    /** Requests that reported no size (cross-origin without Timing-Allow-Origin). */
    readonly unavailable: number;
    /** Requests answered from the cache. */
    readonly cached: number;
  };
  /** Every type of `RESOURCE_TYPES`, in order (types with no request too). */
  readonly byType: readonly ResourceBreakdown[];
  /** The largest requests by weight, at most `SPEED_PANEL_LIMITS.largest` (size-unavailable ones never). */
  readonly largest: readonly LargeResource[];
  /** Uncompressed text responses, largest first, at most `SPEED_PANEL_LIMITS.uncompressed`, of `uncompressedTotal`. */
  readonly uncompressed: readonly UncompressedResource[];
  readonly uncompressedTotal: number;
  readonly thirdParty: {
    readonly requests: number;
    readonly weight: number;
    /** Hosts by weight then requests, at most `SPEED_PANEL_LIMITS.hosts`, of `hostTotal` distinct hosts. */
    readonly hosts: readonly HostShare[];
    readonly hostTotal: number;
  };
  readonly dom: { readonly elements: number; readonly depth: number; readonly depthComplete: boolean };
  readonly navigation: NavigationReport | null;
  /** The resource timing buffer was full (approximate): requests may be missing. */
  readonly bufferFull: boolean;
  /** The URL changed inside the document: requests are counted from the route change, vitals from the page load. */
  readonly softNavigation: boolean;
  /** Native Wayland with no paint entry: FCP, LCP and CLS cannot be measured. */
  readonly paintUnavailable: boolean;
  /** Far fewer requests than the page's fetching elements suggest (`LOW_RESOURCES_RATIO`): a note, never a finding. */
  readonly resourcesLow: boolean;
}

/** The Speed panel's report: the summary and the measurement's `performance` findings (ranked). */
export interface SpeedReport extends SpeedSummary {
  readonly findings: readonly Finding[];
}

/** `seo.measureSpeed`'s answer (`seo-speed.spec.ts`, `SPEED_STATUSES`). */
export type SpeedResponse =
  | { readonly status: 'pending'; readonly url: string }
  | { readonly status: 'ready'; readonly url: string; readonly report: SpeedReport }
  | { readonly status: 'unavailable'; readonly url: string; readonly reason: SpeedUnavailableReason };
