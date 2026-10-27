import { CRAWLER_HONESTY_NOTE, isCrawlerProfile, renderProfileSummary, type AuditRenderProfile } from '@app/specs/render-profile.spec';

// The Overview's line on the render profile the audit ran under (spec `render-profile.feature.md`,
// Recorded with audits): nothing without one.

export function AuditProfileNote({ renderProfile }: { readonly renderProfile: AuditRenderProfile | null }) {
  if (!renderProfile) return null;
  return (
    <section className="seo-audit-profile" data-testid="seo-audit-profile" data-partial={renderProfile.partial}>
      <span className="seo-eyebrow">Rendered as</span>
      <span className="seo-audit-profile-summary" data-testid="seo-audit-profile-summary">
        {renderProfileSummary(renderProfile.profile)}
      </span>
      {renderProfile.partial ? <p className="seo-audit-profile-note">Set after this page loaded: reload it for an audit fully under this profile.</p> : null}
      {isCrawlerProfile(renderProfile.profile) ? <p className="seo-audit-profile-note">{CRAWLER_HONESTY_NOTE}</p> : null}
    </section>
  );
}
