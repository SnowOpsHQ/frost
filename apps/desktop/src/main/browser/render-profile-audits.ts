import type { AuditRenderProfile } from '@app/specs/render-profile.spec';
import type { TabAuditsOptions, TabContents } from '../seo/auditor';

// The render profile each audit ran under (spec `render-profile.feature.md`, Recorded with audits).
// The profile is taken when a run's extraction starts and travels with that run: the extractor's raw
// answer is the run's identity (the auditor hands that very object to the analysis), so the profile
// is kept against it, and then against the audit the analysis makes of it. An audit still on screen
// while a newer run is under way (a reload of the same URL, a re-score) keeps its own label. Weak
// maps only: nothing outlives the audit it describes.

export interface AuditProfiles {
  /** `options` with the extraction and analysis wrapped to record each run's profile. */
  readonly options: TabAuditsOptions;
  /** The profile `audit` ran under (`null`: none, or not known). */
  profileOf(audit: object): AuditRenderProfile | null;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** Wraps `options` so each audit records `profileAt(contents)`, taken when its extraction starts. */
export function withAuditProfiles(options: TabAuditsOptions, profileAt: (contents: TabContents) => AuditRenderProfile | null): AuditProfiles {
  const runs = new WeakMap<object, AuditRenderProfile | null>();
  const audits = new WeakMap<object, AuditRenderProfile | null>();
  return {
    options: {
      ...options,
      extract: (contents) => {
        const profile = profileAt(contents);
        return options.extract(contents).then((raw) => {
          if (isObject(raw)) runs.set(raw, profile);
          return raw;
        });
      },
      analyse: (raw, context) =>
        options.analyse(raw, context).then((result) => {
          if (result.ok && isObject(raw) && runs.has(raw)) audits.set(result.audit, runs.get(raw) ?? null);
          return result;
        }),
    },
    profileOf: (audit) => audits.get(audit) ?? null,
  };
}
