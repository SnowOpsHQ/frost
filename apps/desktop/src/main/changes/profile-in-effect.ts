import { canonicalJson } from '@app/change-intel';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import type { AuditRenderProfile, RenderProfile, TabRenderProfile } from '@app/specs/render-profile.spec';

// The render profile a capture or a screenshot records (`changes-capture.feature.md`, The render
// profile recorded; `screenshot.feature.md`): one rule for both. The profile set on the tab when the
// page was read is recorded whatever its status, `partial` when it may not all have been in effect on
// what was read (set after the load, still applying, or failed). A capture has it from its audit (the
// browser's `auditProfile`, the same rule at the audit's time); a screenshot from the tab's state.

/** The profile in effect on a tab's page now, by the rule an audit's `partial` follows; `null` for none. */
export function tabProfileInEffect(tab: Pick<TabRenderProfile, 'profile' | 'needsReload' | 'status'> | null): AuditRenderProfile | null {
  return tab === null ? null : { profile: tab.profile, partial: tab.needsReload || tab.status !== 'active' };
}

/** A profile in effect, as a row records it. */
export interface RecordedProfile {
  readonly profile: RenderProfile;
  /** Canonical JSON of `profile`. */
  readonly json: string;
  readonly partial: boolean;
}

/** The profile in effect as recorded: `null` for none, `undefined` when it does not fit its schema. */
export function recordedProfile(inEffect: AuditRenderProfile | null): RecordedProfile | null | undefined {
  if (inEffect === null) return null;
  const parsed = RenderProfileSchema.safeParse(inEffect.profile);
  if (!parsed.success) return undefined;
  return { profile: parsed.data, json: canonicalJson(parsed.data), partial: inEffect.partial === true };
}
