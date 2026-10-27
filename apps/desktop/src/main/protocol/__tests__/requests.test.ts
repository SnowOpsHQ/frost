// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md (Who may load app://)
import { describe, expect, test, vi } from 'vitest';
import type { Session } from 'electron';
import { APP_REQUEST_FILTER } from '@app/specs/app-protocol.spec';
import { FakeSession } from '../../../test/electron-fake';
import { restrictAppRequests } from '../requests';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const APP_CONTENTS = { id: 1 };
const APP_DEVTOOLS = { id: 2 };

function setup(isAppWebContents: (contents: { id: number }) => boolean = (c) => c === APP_CONTENTS || c === APP_DEVTOOLS) {
  const ses = new FakeSession();
  restrictAppRequests(ses as unknown as Session, isAppWebContents);
  const request = (webContents: { id: number } | undefined, url = 'app://app/assets/index.js') => {
    const callback = vi.fn();
    ses.beforeRequest?.listener({ id: 1, url, method: 'GET', resourceType: 'script', webContents } as never, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return callback.mock.calls[0]?.[0] as { cancel?: boolean };
  };
  return { ses, request };
}

describe('who may load app://', () => {
  test('registers-one-app-request-filter', () => {
    const { ses } = setup();
    expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(ses.beforeRequest?.filter).toEqual(APP_REQUEST_FILTER);
    expect(APP_REQUEST_FILTER.urls).toEqual(['app://*/*']);
  });

  test('allows-app-window-requests', () => {
    const { request } = setup();
    expect(request(APP_CONTENTS, 'app://app/')).toEqual({ cancel: false });
    expect(request(APP_CONTENTS)).toEqual({ cancel: false });
    expect(request(APP_DEVTOOLS, 'app://app/assets/index.js.map')).toEqual({ cancel: false });
  });

  test('cancels-foreign-requests', () => {
    const { request } = setup();
    expect(request({ id: 3 })).toEqual({ cancel: true });
    expect(request({ id: 3 }, 'app://app/')).toEqual({ cancel: true });
    expect(request(undefined)).toEqual({ cancel: true });
    const throwing = setup(() => {
      throw new Error('destroyed');
    });
    expect(throwing.request(APP_CONTENTS)).toEqual({ cancel: true });
  });
});
