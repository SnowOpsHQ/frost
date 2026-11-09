import { CRAWLER_HONESTY_NOTE, isCrawlerProfile, isDefaultTabOverrides, renderProfileSummary, tabOverridesSummary, type AuditRenderProfile, type TabOverrides } from '@app/specs/render-profile.spec';

// The Overview's line on the render profile the audit ran under (spec `render-profile.feature.md`,
// Recorded with audits), and the tab overrides it ran under (Phase 11 Task 6, the stamp): nothing
// without either.

export function AuditProfileNote({ renderProfile, tabOverrides = null }: { readonly renderProfile: AuditRenderProfile | null; readonly tabOverrides?: TabOverrides | null }) {
  const overrides = tabOverrides !== null && !isDefaultTabOverrides(tabOverrides) ? tabOverridesSummary(tabOverrides) : null;
  if (!renderProfile && overrides === null) return null;
  return (
    <section className="seo-audit-profile" data-testid="seo-audit-profile" data-partial={renderProfile?.partial ?? false}>
      {renderProfile ? (
        <>
          <span className="seo-eyebrow">Rendered as</span>
          <span className="seo-audit-profile-summary" data-testid="seo-audit-profile-summary">
            {renderProfileSummary(renderProfile.profile)}
          </span>
          {renderProfile.partial ? <p className="seo-audit-profile-note">Set after this page loaded: reload it for an audit fully under this profile.</p> : null}
          {isCrawlerProfile(renderProfile.profile) ? <p className="seo-audit-profile-note">{CRAWLER_HONESTY_NOTE}</p> : null}
        </>
      ) : null}
      {overrides !== null ? (
        <>
          <span className="seo-eyebrow">This tab only</span>
          <span className="seo-audit-profile-summary" data-testid="seo-audit-overrides">
            {overrides}
          </span>
        </>
      ) : null}
    </section>
  );
}
