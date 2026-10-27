// Spec: specs/devtools.spec.ts (NETWORK_LIMITS: the recording decision)
// Acceptance: specs/devtools.feature.md (Request observers)
import { describe, expect, test, vi } from 'vitest';
import { MAIN_FRAME_FILTER, observeMainFrames, observeRequests, REQUEST_FILTER, type ObservedSession } from '../web-request';

/** A session's `webRequest` like Electron's: one listener per event (registering again replaces it), filters kept. */
function fakeSession() {
  const listeners: Record<string, ((details: unknown) => void) | null> = {};
  const filters: Record<string, unknown> = {};
  const register = (event: string) =>
    vi.fn((filter: unknown, listener: ((details: unknown) => void) | null) => {
      filters[event] = filter;
      listeners[event] = listener;
    });
  const webRequest = {
    onBeforeRedirect: register('redirect'),
    onResponseStarted: register('response'),
    onErrorOccurred: register('error'),
    onSendHeaders: register('send'),
    onCompleted: register('completed'),
    // Blocking listeners: never registered.
    onBeforeRequest: register('before-request'),
    onBeforeSendHeaders: register('before-send-headers'),
    onHeadersReceived: register('headers-received'),
  };
  return { session: { webRequest } as unknown as ObservedSession, webRequest, listeners, filters };
}

describe('request observers', () => {
  test('request-observers-share-the-session-listeners', () => {
    const { session, webRequest, listeners, filters } = fakeSession();
    const mainFrame = { responded: vi.fn(), redirected: vi.fn(), failed: vi.fn() };
    observeMainFrames(session, mainFrame);
    expect(filters.response).toEqual(MAIN_FRAME_FILTER);
    expect(webRequest.onSendHeaders).not.toHaveBeenCalled();

    const throwing = { sent: vi.fn(() => { throw new Error('boom'); }) };
    const requests = { sent: vi.fn(), redirected: vi.fn(), responded: vi.fn(), completed: vi.fn(), failed: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    observeRequests(session, throwing);
    const remove = observeRequests(session, requests);
    // Widened once: every resource type, the main-frame ones re-installed, two more observed.
    expect(webRequest.onResponseStarted).toHaveBeenCalledTimes(2);
    expect(webRequest.onSendHeaders).toHaveBeenCalledTimes(1);
    expect(webRequest.onCompleted).toHaveBeenCalledTimes(1);
    for (const event of ['redirect', 'response', 'error', 'send', 'completed']) expect(filters[event], event).toEqual(REQUEST_FILTER);
    expect(REQUEST_FILTER.types).toBeUndefined();
    // No blocking listener: no request ever waits for main.
    expect(webRequest.onBeforeRequest).not.toHaveBeenCalled();
    expect(webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
    expect(webRequest.onHeadersReceived).not.toHaveBeenCalled();

    // A subresource reaches the request observers only; a main frame both.
    listeners.response!({ id: 1, resourceType: 'image' });
    expect(requests.responded).toHaveBeenCalledWith({ id: 1, resourceType: 'image' });
    expect(mainFrame.responded).not.toHaveBeenCalled();
    listeners.response!({ id: 2, resourceType: 'mainFrame' });
    expect(mainFrame.responded).toHaveBeenCalledWith({ id: 2, resourceType: 'mainFrame' });
    expect(requests.responded).toHaveBeenCalledTimes(2);
    listeners.redirect!({ id: 3, resourceType: 'script' });
    listeners.error!({ id: 4, resourceType: 'mainFrame' });
    expect(mainFrame.redirected).not.toHaveBeenCalled();
    expect(mainFrame.failed).toHaveBeenCalledTimes(1);
    expect(requests.redirected).toHaveBeenCalledTimes(1);
    expect(requests.failed).toHaveBeenCalledTimes(1);
    // One observer throwing never keeps the event from the next.
    listeners.send!({ id: 5 });
    expect(throwing.sent).toHaveBeenCalledTimes(1);
    expect(requests.sent).toHaveBeenCalledWith({ id: 5 });
    expect(error).toHaveBeenCalled();
    listeners.completed!({ id: 6 });
    expect(requests.completed).toHaveBeenCalledWith({ id: 6 });

    // A third request observer joins the same listeners.
    observeRequests(session, { sent: vi.fn() });
    expect(webRequest.onSendHeaders).toHaveBeenCalledTimes(1);
    remove();
    listeners.send!({ id: 7 });
    expect(requests.sent).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
