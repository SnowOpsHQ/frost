import { shell, type WebContents } from 'electron';
import { hasTransientActivation, isActivationInput, parseExternalUrl, resolveExternalOpen } from './policy';

// The Phase 0 external-open flow (spec `security-policy.spec.ts`, acceptance `external-url.feature.md`),
// shared by the app pin (`register.ts`) and the browse guard (`browser/guard.ts`, Task 3) so the
// gesture rules and the scheme allowlist live in one place.

export interface UserGesture {
  /**
   * Whether a trusted activation input arrived within `USER_ACTIVATION_WINDOW_MS`; reading it
   * consumes it (like Chromium's transient activation), so one activation backs at most one open.
   */
  consume(): boolean;
}

/**
 * Tracks trusted activation inputs (`input-event`: OS/browser input only, never page-synthesized)
 * on `contents`. Per WebContents, not per frame (spec known limit: Electron reports neither input
 * nor window-open per frame).
 */
export function trackUserGesture(contents: WebContents, now: () => number): UserGesture {
  let lastActivationAt: number | undefined;
  contents.on('input-event', (_event, input) => {
    if (isActivationInput(input.type)) lastActivationAt = now();
  });
  return {
    consume() {
      const userGesture = hasTransientActivation(lastActivationAt, now());
      lastActivationAt = undefined;
      return userGesture;
    },
  };
}

/**
 * Opens `url` with `shell.openExternal` if `resolveExternalOpen` allows it (allowlisted scheme,
 * strict string rules, a real gesture), passing the parsed `href`, never the raw input. Answers
 * whether it was opened.
 */
export function openExternalIfAllowed(url: string, userGesture: boolean): boolean {
  const target = parseExternalUrl(url);
  if (!target || resolveExternalOpen(url, { userGesture }) !== 'allow') return false;
  shell.openExternal(target.href).catch((err: unknown) => console.error('openExternal failed', err));
  return true;
}
