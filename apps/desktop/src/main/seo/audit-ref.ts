import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';

// The audit the chrome rendered (`SeoAuditRefSchema` in `seo-snapshot.spec.ts`: its URL and when it
// was taken), shared by every copy and export main writes from a tab's ready audit (Phase 11 Task 1,
// Decision 1; moved out of `browser/controller.ts`).

/** Whether `audit` is the one the panel rendered (`SeoAuditRef`: its URL and when it was taken). */
export function sameAudit(audit: { readonly url: string; readonly takenAt: number }, shown: { readonly url: string; readonly takenAt: number }): boolean {
  return audit.url === shown.url && audit.takenAt === shown.takenAt;
}

/** The ready audit of `response` if it is the one shown (`shown`); else `null` (pending, unavailable, stale). */
export function shownAudit(response: SeoAuditResponse, shown: { readonly url: string; readonly takenAt: number }): SeoAudit | null {
  return response.status === 'ready' && sameAudit(response.audit, shown) ? response.audit : null;
}
