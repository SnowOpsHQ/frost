// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { LoadError } from '@app/specs/browser.spec';
import {
  CERT_ERROR_CODE_RANGE,
  CRASH_TITLE,
  INSECURE_RESPONSE_ERROR_CODE,
  LOAD_ERROR_TITLES,
  OFFLINE_ERROR_CODES,
  UNREACHABLE_ERROR_CODES,
  type LoadErrorClass,
} from '@app/specs/browse-guard.spec';

// The chrome's error and crash panels (spec `browse-guard.feature.md`, Renderer): pure copy and
// actions, so the panel component only renders what this answers.

export type PanelAction = 'back' | 'retry';

export interface LoadErrorView {
  readonly errorClass: LoadErrorClass;
  readonly title: string;
  readonly message: string;
  /** Chromium's short error name (`ERR_CONNECTION_REFUSED`), shown small under the message. */
  readonly detail: string;
  /** In display order. A certificate error is never bypassable: there is no "proceed" action. */
  readonly actions: readonly PanelAction[];
}

const ERR_TIMED_OUT = -7;
const ERR_CONNECTION_REFUSED = -102;
const ERR_NAME_NOT_RESOLVED = -105;
const ERR_CONNECTION_TIMED_OUT = -118;
const ERR_NAME_RESOLUTION_FAILED = -137;

/** Whether `code` is a certificate failure (`CERT_ERROR_CODE_RANGE`, `INSECURE_RESPONSE_ERROR_CODE`). */
export function isCertificateErrorCode(code: number): boolean {
  return (code >= CERT_ERROR_CODE_RANGE.min && code <= CERT_ERROR_CODE_RANGE.max) || code === INSECURE_RESPONSE_ERROR_CODE;
}

export function loadErrorClass(code: number): LoadErrorClass {
  if (isCertificateErrorCode(code)) return 'certificate';
  if ((OFFLINE_ERROR_CODES as readonly number[]).includes(code)) return 'offline';
  if ((UNREACHABLE_ERROR_CODES as readonly number[]).includes(code)) return 'unreachable';
  return 'generic';
}

/** The host (with port) of `url`, else a neutral stand-in. */
export function panelHost(url: string): string {
  try {
    const host = new URL(url).host;
    if (host !== '') return host;
  } catch {
    // Not a URL: fall through.
  }
  return 'this site';
}

function unreachableMessage(code: number, host: string): string {
  if (code === ERR_CONNECTION_REFUSED) return `${host} refused to connect.`;
  if (code === ERR_NAME_NOT_RESOLVED || code === ERR_NAME_RESOLUTION_FAILED) return `${host}’s server address couldn’t be found.`;
  if (code === ERR_CONNECTION_TIMED_OUT || code === ERR_TIMED_OUT) return `${host} took too long to respond.`;
  return `The connection to ${host} failed.`;
}

function message(errorClass: LoadErrorClass, code: number, host: string): string {
  switch (errorClass) {
    case 'certificate':
      return `frost couldn’t verify the certificate of ${host}, so the page wasn’t loaded. Someone may be impersonating the site.`;
    case 'offline':
      return `frost couldn’t reach ${host} because this device isn’t connected to a network.`;
    case 'unreachable':
      return unreachableMessage(code, host);
    case 'generic':
      return `Something went wrong while loading ${host}.`;
  }
}

/** What the error panel shows for `error` (`canGoBack`: whether the tab has a page to go back to). */
export function loadErrorView(error: LoadError, canGoBack: boolean): LoadErrorView {
  const errorClass = loadErrorClass(error.code);
  const host = panelHost(error.url);
  return {
    errorClass,
    title: LOAD_ERROR_TITLES[errorClass],
    message: message(errorClass, error.code, host),
    detail: error.description,
    actions: canGoBack ? ['back', 'retry'] : ['retry'],
  };
}

/** What the crash panel shows for a tab whose renderer is gone. */
export function crashView(url: string): { readonly title: string; readonly message: string } {
  return { title: CRASH_TITLE, message: `Something went wrong while showing ${panelHost(url)}. Reload to try again.` };
}
