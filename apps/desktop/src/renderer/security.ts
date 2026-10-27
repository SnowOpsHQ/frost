import type { TabState } from '@app/specs/browser.spec';
import { urlSecurity, type UrlSecurity } from '@app/specs/web-url.spec';
import { isCertificateErrorCode } from './page-error';

// What the chrome shows about a tab's connection. Pure.

/** A tab's badge: never the lock for a failed load (a refused certificate is "not secure"). */
export function tabSecurity(tab: TabState | undefined): UrlSecurity {
  if (!tab) return 'none';
  if (tab.error) return isCertificateErrorCode(tab.error.code) ? 'insecure' : 'none';
  return urlSecurity(tab.url);
}

/** `url`'s host (with port), or `''` for anything that is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
