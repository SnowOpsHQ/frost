import { DEFAULT_TAB_OVERRIDES, type AuditRenderProfile, type TabOverrides } from '@app/specs/render-profile.spec';
import type { TabAuditsOptions, TabContents } from '../seo/auditor';

// The render profile each audit ran under (spec `render-profile.feature.md`, Recorded with audits).
// The profile is taken when a run's extraction starts and travels with that run: the extractor's raw
// answer is the run's identity (the auditor hands that very object to the analysis), so the profile
// is kept against it, and then against the audit the analysis makes of it. An audit still on screen
// while a newer run is under way (a reload of the same URL, a re-score) keeps its own label. Weak
// maps only: nothing outlives the audit it describes.
//
// The tab overrides each audit ran under (Phase 11 Task 6, Decision 8; `render-profile.feature.md`,
// Tab overrides: the stamp) are recorded the same way, with every audit whether or not a profile is
// set, in maps of their own: `profileOf` and the profile it answers never carry them.

export interface AuditProfiles {
  /** `options` with the extraction and analysis wrapped to record each run's profile and overrides. */
  readonly options: TabAuditsOptions;
  /** The profile `audit` ran under (`null`: none, or not known). */
  profileOf(audit: object): AuditRenderProfile | null;
  /** The tab overrides `audit` ran under (the stamp; all off when not known). */
  overridesOf(audit: object): TabOverrides;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * Wraps `options` so each audit records `profileAt(contents)` and `overridesAt(contents)`, taken when
 * its extraction starts (without `overridesAt`, every audit records all off).
 */
export function withAuditProfiles(options: TabAuditsOptions, profileAt: (contents: TabContents) => AuditRenderProfile | null, overridesAt?: (contents: TabContents) => TabOverrides): AuditProfiles {
  const runs = new WeakMap<object, AuditRenderProfile | null>();
  const audits = new WeakMap<object, AuditRenderProfile | null>();
  const runOverrides = new WeakMap<object, TabOverrides>();
  const auditOverrides = new WeakMap<object, TabOverrides>();
  return {
    options: {
      ...options,
      extract: (contents) => {
        const profile = profileAt(contents);
        const overrides = overridesAt?.(contents) ?? DEFAULT_TAB_OVERRIDES;
        return options.extract(contents).then((raw) => {
          if (isObject(raw)) {
            runs.set(raw, profile);
            runOverrides.set(raw, overrides);
          }
          return raw;
        });
      },
      analyse: (raw, context) =>
        options.analyse(raw, context).then((result) => {
          if (result.ok && isObject(raw) && runs.has(raw)) audits.set(result.audit, runs.get(raw) ?? null);
          if (result.ok && isObject(raw) && runOverrides.has(raw)) auditOverrides.set(result.audit, runOverrides.get(raw)!);
          return result;
        }),
    },
    profileOf: (audit) => audits.get(audit) ?? null,
    overridesOf: (audit) => auditOverrides.get(audit) ?? DEFAULT_TAB_OVERRIDES,
  };
}
