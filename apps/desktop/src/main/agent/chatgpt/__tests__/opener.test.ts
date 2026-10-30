// Spec: specs/agent-chatgpt.spec.ts (isChatgptAuthorizeUrl, CHATGPT_ENDPOINTS.authorize)
// Acceptance: specs/agent-chatgpt.feature.md (Router: chatgpt-browser-opener) · plan docs/plans/agent-chatgpt-plan.md, Task 5
import { describe, expect, test, vi } from 'vitest';
import { CHATGPT_ENDPOINTS, CHATGPT_USAGE_URL } from '@app/specs/agent-chatgpt.spec';
import { chatgptBrowserOpener } from '../opener';

describe('chatgpt browser opener', () => {
  test('chatgpt-browser-opener (only the authorize page, only on a spent user gesture)', () => {
    const open = vi.fn((_url: string, _userGesture: boolean) => true);
    const opener = chatgptBrowserOpener(open);
    const authorize = `${CHATGPT_ENDPOINTS.authorize}?response_type=code&client_id=dynamic_agent_client`;
    // No gesture: never opened, even for the right page.
    expect(opener(authorize, false)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    // Any other URL: never opened, even with a gesture.
    for (const url of [CHATGPT_USAGE_URL, CHATGPT_ENDPOINTS.authorize, 'https://example.com/?x', `${CHATGPT_ENDPOINTS.token}?x`, 'file:///etc/passwd', `${CHATGPT_ENDPOINTS.authorize}.evil.example?x`]) {
      expect(opener(url, true), url).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    expect(opener(authorize, true)).toBe(true);
    expect(open).toHaveBeenCalledWith(authorize, true);
    // The allowlisted opener's own answer stands.
    open.mockReturnValueOnce(false);
    expect(opener(authorize, true)).toBe(false);
  });
});
