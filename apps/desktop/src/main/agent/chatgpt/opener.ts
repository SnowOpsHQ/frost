import { isChatgptAuthorizeUrl } from '@app/specs/agent-chatgpt.spec';

// The ChatGPT sign-in's browser opener (plan `docs/plans/agent-chatgpt-plan.md`, Task 5; acceptance
// `agent-chatgpt.feature.md`, Router). `agent.chatgptSignIn` spends the sender window's live user
// gesture before the sign-in starts and the service passes that on (`userGesture`); this opens
// nothing without it, and nothing but the authorize page (`isChatgptAuthorizeUrl`), whatever the
// scheme allowlist would allow. `open` is main's scheme-allowlisted `openExternalIfAllowed`.

/** `authorize`: the authorize endpoint (default `CHATGPT_ENDPOINTS.authorize`; the unpackaged e2e seam's fake otherwise). */
export function chatgptBrowserOpener(open: (url: string, userGesture: boolean) => boolean, authorize?: string): (url: string, userGesture: boolean) => boolean {
  return (url, userGesture) => userGesture === true && isChatgptAuthorizeUrl(url, authorize) && open(url, true) === true;
}
