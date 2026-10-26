// Spec: specs/permissions.spec.ts, specs/browser.spec.ts (PermissionPromptSchema)
// Acceptance: specs/permissions.feature.md (Decisions, Broker, Session wiring)
import type { BrowserWindow, Session } from 'electron';
import { session } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, PermissionPromptSchema } from '@app/specs/browser.spec';
import {
  MAX_PENDING_PROMPTS_PER_TAB,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PROMPTABLE_PERMISSIONS,
  SILENTLY_ALLOWED_PERMISSIONS,
  type SitePermission,
} from '@app/specs/permissions.spec';
import { FakeBrowserWindow, FakeSession } from '../../../test/electron-fake';
import { registerSecurity } from '../../security/register';
import { hardenBrowseSession } from '../guard';
import {
  classifyPermissionRequest,
  createBrowsePermissionHandlers,
  createMemoryDecisionStore,
  createPermissionBroker,
  requestingOrigin,
  type PermissionBroker,
  type PermissionDecisionStore,
} from '../permissions';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const A = 'https://a.example';
const B = 'https://b.example:8443';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const notifications = (origin = A) => ({ origin, permission: 'notifications' as const });
const geolocation = (origin = A) => ({ origin, permission: 'geolocation' as const });
const media = (mediaTypes: ('video' | 'audio')[], origin = A) => ({ origin, permission: 'media' as const, mediaTypes });

/** A permission callback that records its answers. */
const answerSpy = () => vi.fn<(granted: boolean) => void>();

function headId(broker: PermissionBroker, tabId: number): string {
  const prompt = broker.promptFor(tabId);
  if (!prompt) throw new Error(`tab ${tabId} shows no prompt`);
  return prompt.id;
}

describe('decisions', () => {
  const frame = (requestingUrl: string, extra: object = {}) => ({ isMainFrame: true, requestingUrl, ...extra });

  test('promptable-permissions-prompt', () => {
    for (const permission of ['geolocation', 'notifications', 'clipboard-read'] as const) {
      expect(classifyPermissionRequest(permission, frame('https://a.example/page?q=1')), permission).toEqual({
        kind: 'prompt',
        ask: { origin: A, permission },
      });
    }
    expect(classifyPermissionRequest('media', frame('https://a.example/', { mediaTypes: ['video'] }))).toEqual({
      kind: 'prompt',
      ask: { origin: A, permission: 'media', mediaTypes: ['video'] },
    });
    expect(PROMPTABLE_PERMISSIONS).toEqual(['geolocation', 'notifications', 'media', 'clipboard-read']);
  });

  test('silently-allowed-permissions', () => {
    expect(SILENTLY_ALLOWED_PERMISSIONS).toEqual(['fullscreen', 'clipboard-sanitized-write']);
    for (const permission of SILENTLY_ALLOWED_PERMISSIONS) {
      expect(classifyPermissionRequest(permission, frame('https://a.example/')), permission).toEqual({ kind: 'allow' });
      expect(classifyPermissionRequest(permission, frame('about:blank')), permission).toEqual({ kind: 'allow' });
    }
  });

  test('other-permissions-denied-silently', () => {
    const denied = [
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'pointerLock',
      'keyboardLock',
      'openExternal',
      'display-capture',
      'idle-detection',
      'window-management',
      'persistent-storage',
      'automatic-fullscreen',
      'storage-access',
      'mediaKeySystem',
      'unknown',
      '',
      'frost-made-up',
      'toString',
      '__proto__',
    ];
    for (const permission of denied) {
      expect(classifyPermissionRequest(permission, frame('https://a.example/')), permission).toEqual({ kind: 'deny' });
    }
  });

  test('media-split-into-camera-and-microphone', () => {
    const ask = (mediaTypes: unknown) => classifyPermissionRequest('media', frame('https://a.example/', { mediaTypes }));
    expect(ask(['audio', 'video'])).toEqual({ kind: 'prompt', ask: media(['video', 'audio']) });
    expect(ask(['video', 'audio', 'video'])).toEqual({ kind: 'prompt', ask: media(['video', 'audio']) });
    expect(ask(['video'])).toEqual({ kind: 'prompt', ask: media(['video']) });
    expect(ask(['audio'])).toEqual({ kind: 'prompt', ask: media(['audio']) });
    for (const none of [undefined, [], ['screen'], 'video', null]) expect(ask(none), String(none)).toEqual({ kind: 'deny' });
  });

  test('requesting-origin-from-requesting-url', () => {
    expect(requestingOrigin({ requestingUrl: 'https://frame.example:4443/a/b?c#d' })).toBe('https://frame.example:4443');
    expect(requestingOrigin({ requestingUrl: 'HTTP://127.0.0.1:8080/x' })).toBe('http://127.0.0.1:8080');
    // Media requests also carry the security origin; the requesting URL wins when present.
    expect(requestingOrigin({ requestingUrl: 'https://frame.example/', securityOrigin: 'https://other.example/' })).toBe('https://frame.example');
    expect(requestingOrigin({ securityOrigin: 'https://frame.example/' })).toBe('https://frame.example');
    for (const url of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'file:///etc/passwd', 'app://app/', 'blob:https://a.example/x', 'not a url', '']) {
      expect(requestingOrigin({ requestingUrl: url }), url).toBeNull();
      expect(classifyPermissionRequest('notifications', frame(url)), url).toEqual({ kind: 'deny' });
    }
    expect(requestingOrigin(undefined)).toBeNull();
    expect(requestingOrigin({})).toBeNull();
    expect(classifyPermissionRequest('geolocation', undefined)).toEqual({ kind: 'deny' });
  });
});

describe('broker', () => {
  let broker: PermissionBroker;
  let changes: number;

  beforeEach(() => {
    broker = createPermissionBroker();
    changes = 0;
    broker.subscribe(() => {
      changes += 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('prompt-queues-per-tab', () => {
    const first = answerSpy();
    const second = answerSpy();
    const other = answerSpy();
    broker.request(1, notifications(), first);
    broker.request(1, geolocation(), second);
    broker.request(2, notifications(B), other);
    const prompt = broker.promptFor(1);
    expect(PermissionPromptSchema.parse(prompt)).toEqual(prompt);
    expect(prompt).toMatchObject({ origin: A, permission: 'notifications' });
    expect(prompt).not.toHaveProperty('mediaTypes');
    expect(broker.promptFor(2)).toMatchObject({ origin: B, permission: 'notifications' });
    expect(changes).toBe(3);

    expect(broker.answer(1, headId(broker, 1), 'dismiss')).toBe(true);
    expect(first).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(1)).toMatchObject({ origin: A, permission: 'geolocation' });
    expect(second).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(broker.promptFor(3)).toBeNull();
  });

  test('duplicate-requests-coalesce', () => {
    const one = answerSpy();
    const two = answerSpy();
    broker.request(1, notifications(), one);
    const id = headId(broker, 1);
    broker.request(1, notifications(), two);
    expect(headId(broker, 1)).toBe(id);
    expect(broker.pendingCount()).toBe(1);
    expect(broker.answer(1, id, 'allow')).toBe(true);
    expect(one).toHaveBeenCalledExactlyOnceWith(true);
    expect(two).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.promptFor(1)).toBeNull();
  });

  test('allow-is-remembered', () => {
    const asked = answerSpy();
    const elsewhere = answerSpy();
    broker.request(1, notifications(), asked);
    broker.request(2, notifications(), elsewhere);
    expect(broker.answer(1, headId(broker, 1), 'allow')).toBe(true);
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    // The same (origin, permission) pending in another tab is settled by the remembered Allow.
    expect(elsewhere).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.promptFor(2)).toBeNull();
    const again = answerSpy();
    broker.request(3, notifications(), again);
    expect(again).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.promptFor(3)).toBeNull();
  });

  test('block-is-remembered', () => {
    const asked = answerSpy();
    broker.request(1, geolocation(), asked);
    expect(broker.answer(1, headId(broker, 1), 'block')).toBe(true);
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
    const again = answerSpy();
    broker.request(1, geolocation(), again);
    expect(again).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(1)).toBeNull();
    expect(broker.check(A, 'geolocation')).toBe(false);
  });

  test('dismiss-denies-once', () => {
    const asked = answerSpy();
    broker.request(1, notifications(), asked);
    const id = headId(broker, 1);
    expect(broker.answer(1, id, 'dismiss')).toBe(true);
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
    const again = answerSpy();
    broker.request(1, notifications(), again);
    expect(again).not.toHaveBeenCalled();
    expect(headId(broker, 1)).not.toBe(id);
  });

  test('remembered-per-origin-and-permission', () => {
    broker.request(1, notifications(A), answerSpy());
    broker.answer(1, headId(broker, 1), 'allow');
    const otherOrigin = answerSpy();
    const otherPermission = answerSpy();
    broker.request(1, notifications(B), otherOrigin);
    broker.request(1, geolocation(A), otherPermission);
    expect(otherOrigin).not.toHaveBeenCalled();
    expect(otherPermission).not.toHaveBeenCalled();
    expect(broker.promptFor(1)).toMatchObject({ origin: B, permission: 'notifications' });
    expect(broker.check(B, 'notifications')).toBe(false);
    expect(broker.check(A, 'geolocation')).toBe(false);
  });

  test('media-remembers-each-device', () => {
    broker.request(1, media(['video', 'audio']), answerSpy());
    expect(broker.promptFor(1)).toMatchObject({ permission: 'media', mediaTypes: ['video', 'audio'] });
    broker.answer(1, headId(broker, 1), 'allow');
    const cameraOnly = answerSpy();
    broker.request(1, media(['video']), cameraOnly);
    expect(cameraOnly).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.check(A, 'camera')).toBe(true);
    expect(broker.check(A, 'microphone')).toBe(true);

    // Block one device of another origin: asking for both is denied at once.
    broker.request(1, media(['audio'], B), answerSpy());
    broker.answer(1, headId(broker, 1), 'block');
    const both = answerSpy();
    broker.request(1, media(['video', 'audio'], B), both);
    expect(both).toHaveBeenCalledExactlyOnceWith(false);

    // Only the camera decided: the prompt asks for the microphone only.
    const C = 'https://c.example';
    broker.request(1, media(['video'], C), answerSpy());
    broker.answer(1, headId(broker, 1), 'allow');
    const rest = answerSpy();
    broker.request(1, media(['video', 'audio'], C), rest);
    expect(broker.promptFor(1)).toMatchObject({ origin: C, permission: 'media', mediaTypes: ['audio'] });
    broker.answer(1, headId(broker, 1), 'allow');
    expect(rest).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('check-reflects-remembered-allow', () => {
    const decide = (origin: string, permission: 'notifications' | 'geolocation', decision: 'allow' | 'block' | 'dismiss') => {
      broker.request(1, { origin, permission }, answerSpy());
      broker.answer(1, headId(broker, 1), decision);
    };
    expect(broker.check(A, 'notifications')).toBe(false);
    decide(A, 'notifications', 'dismiss');
    expect(broker.check(A, 'notifications')).toBe(false);
    decide(A, 'notifications', 'allow');
    expect(broker.check(A, 'notifications')).toBe(true);
    decide(B, 'geolocation', 'block');
    expect(broker.check(B, 'geolocation')).toBe(false);
    expect(broker.check(B, 'notifications')).toBe(false);
  });

  test('prompt-times-out', () => {
    vi.useFakeTimers();
    broker = createPermissionBroker();
    const first = answerSpy();
    const second = answerSpy();
    broker.request(1, notifications(), first);
    vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS / 2);
    broker.request(1, geolocation(), second);
    vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS / 2 - 1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.check(A, 'notifications')).toBe(false);
    expect(broker.promptFor(1)).toMatchObject({ permission: 'geolocation' });
    // The timed-out prompt asks again next time (nothing remembered).
    const again = answerSpy();
    broker.request(1, notifications(), again);
    expect(again).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS / 2);
    expect(second).toHaveBeenCalledExactlyOnceWith(false);
    // Answered prompts leave no timer behind.
    broker.answer(1, headId(broker, 1), 'dismiss');
    expect(again).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('prompt-ids-are-opaque-and-single-use', () => {
    const ids = new Set<string>();
    for (let tab = 1; tab <= 20; tab++) {
      broker.request(tab, notifications(`https://site${tab}.example`), answerSpy());
      const id = headId(broker, tab);
      expect(id).toMatch(UUID);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
    const asked = answerSpy();
    broker.request(21, geolocation(), asked);
    const id = headId(broker, 21);
    expect(broker.answer(21, id, 'block')).toBe(true);
    expect(broker.answer(21, id, 'allow')).toBe(false);
    expect(broker.answer(21, crypto.randomUUID(), 'allow')).toBe(false);
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.check(A, 'geolocation')).toBe(false);
  });

  test('answer-needs-the-tabs-shown-prompt', () => {
    // Record the ids the broker mints, to try the queued prompt's (never shown to the chrome).
    const minted: string[] = [];
    broker = createPermissionBroker({
      randomId: () => {
        const id = crypto.randomUUID();
        minted.push(id);
        return id;
      },
    });
    const one = answerSpy();
    const queued = answerSpy();
    const two = answerSpy();
    broker.request(1, notifications(), one);
    broker.request(1, geolocation(), queued);
    broker.request(2, notifications(B), two);
    expect(minted).toHaveLength(3);
    const [head1, queuedId, head2] = minted as [string, string, string];
    expect(headId(broker, 1)).toBe(head1);
    expect(headId(broker, 2)).toBe(head2);
    // Another tab's prompt id, answered as if for this tab (both ways), and a queued prompt's id.
    expect(broker.answer(1, head2, 'allow')).toBe(false);
    expect(broker.answer(2, head1, 'allow')).toBe(false);
    expect(broker.answer(1, queuedId, 'allow')).toBe(false);
    for (const callback of [one, queued, two]) expect(callback).not.toHaveBeenCalled();
    expect(headId(broker, 1)).toBe(head1);
    expect(headId(broker, 2)).toBe(head2);
    expect(broker.check(A, 'geolocation')).toBe(false);
    expect(broker.check(B, 'notifications')).toBe(false);
    // Once it is the head, the queued prompt can be answered.
    expect(broker.answer(1, head1, 'dismiss')).toBe(true);
    expect(broker.answer(1, queuedId, 'allow')).toBe(true);
    expect(queued).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('deny-tab-denies-pending', () => {
    const one = answerSpy();
    const two = answerSpy();
    const other = answerSpy();
    broker.request(1, notifications(), one);
    broker.request(1, geolocation(), two);
    broker.request(2, notifications(B), other);
    const before = changes;
    broker.denyTab(1);
    expect(one).toHaveBeenCalledExactlyOnceWith(false);
    expect(two).toHaveBeenCalledExactlyOnceWith(false);
    expect(other).not.toHaveBeenCalled();
    expect(broker.promptFor(1)).toBeNull();
    expect(broker.promptFor(2)).not.toBeNull();
    expect(changes).toBe(before + 1);
    broker.denyTab(1);
    broker.denyTab(99);
    expect(changes).toBe(before + 1);
    expect(broker.check(A, 'notifications')).toBe(false);
  });

  test('pending-prompts-capped-per-tab', () => {
    const callbacks = Array.from({ length: MAX_PENDING_PROMPTS_PER_TAB }, () => answerSpy());
    callbacks.forEach((callback, i) => broker.request(1, notifications(`https://s${i}.example`), callback));
    expect(broker.pendingCount()).toBe(MAX_PENDING_PROMPTS_PER_TAB);
    const extra = answerSpy();
    broker.request(1, notifications('https://extra.example'), extra);
    expect(extra).toHaveBeenCalledExactlyOnceWith(false);
    // A duplicate of a pending one still coalesces; other tabs have their own room.
    const duplicate = answerSpy();
    broker.request(1, notifications('https://s0.example'), duplicate);
    expect(duplicate).not.toHaveBeenCalled();
    const otherTab = answerSpy();
    broker.request(2, notifications('https://extra.example'), otherTab);
    expect(otherTab).not.toHaveBeenCalled();
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();
  });

  test('decision-store-is-swappable', () => {
    const saved = new Map<string, 'allow' | 'block'>([[`${B} notifications`, 'allow']]);
    const store: PermissionDecisionStore = {
      get: vi.fn((origin: string, permission: SitePermission) => saved.get(`${origin} ${permission}`)),
      set: vi.fn((origin: string, permission: SitePermission, decision: 'allow' | 'block') => {
        saved.set(`${origin} ${permission}`, decision);
      }),
    };
    const custom = createPermissionBroker({ store });
    const remembered = answerSpy();
    custom.request(1, notifications(B), remembered);
    expect(remembered).toHaveBeenCalledExactlyOnceWith(true);
    expect(custom.check(B, 'notifications')).toBe(true);
    custom.request(1, geolocation(A), answerSpy());
    custom.answer(1, headId(custom, 1), 'block');
    expect(store.set).toHaveBeenCalledExactlyOnceWith(A, 'geolocation', 'block');
    expect(saved.get(`${A} geolocation`)).toBe('block');
    // The memory store is that same interface.
    const memory = createMemoryDecisionStore();
    expect(memory.get(A, 'camera')).toBeUndefined();
    memory.set(A, 'camera', 'allow');
    expect(memory.get(A, 'camera')).toBe('allow');
    expect(memory.get(B, 'camera')).toBeUndefined();
  });
});

describe('browse session', () => {
  const TAB_CONTENTS = { id: 'tab' };
  const TOP = 'https://top.example';
  const FRAME = 'https://frame.example:4443';
  let broker: PermissionBroker;
  let ses: FakeSession;

  beforeEach(() => {
    broker = createPermissionBroker();
    ses = new FakeSession();
    const handlers = createBrowsePermissionHandlers({ broker, tabIdOf: (contents) => (contents === TAB_CONTENTS ? 7 : null) });
    hardenBrowseSession(ses as unknown as Session, { permissions: handlers });
  });

  const request = (contents: unknown, permission: string, details: object) => {
    const callback = answerSpy();
    ses.permissionRequestHandler?.(contents, permission, callback, details);
    return callback;
  };
  const check = (permission: string, origin: string, details: object = { isMainFrame: true }) =>
    ses.permissionCheckHandler?.(TAB_CONTENTS, permission, origin, details);

  test('browse-session-prompts-for-tabs', () => {
    const asked = request(TAB_CONTENTS, 'notifications', { isMainFrame: true, requestingUrl: `${TOP}/page` });
    expect(asked).not.toHaveBeenCalled();
    expect(broker.promptFor(7)).toMatchObject({ origin: TOP, permission: 'notifications' });
    expect(request({ id: 'not a tab' }, 'notifications', { isMainFrame: true, requestingUrl: `${TOP}/` })).toHaveBeenCalledExactlyOnceWith(false);
    expect(request(null, 'geolocation', { isMainFrame: true, requestingUrl: `${TOP}/` })).toHaveBeenCalledExactlyOnceWith(false);
    expect(request(TAB_CONTENTS, 'fullscreen', { isMainFrame: true, requestingUrl: `${TOP}/` })).toHaveBeenCalledExactlyOnceWith(true);
    expect(request(TAB_CONTENTS, 'midi', { isMainFrame: true, requestingUrl: `${TOP}/` })).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.pendingCount()).toBe(1);
  });

  test('prompt-names-requesting-origin', () => {
    const asked = request(TAB_CONTENTS, 'geolocation', { isMainFrame: false, requestingUrl: `${FRAME}/embed?x=1` });
    const prompt = broker.promptFor(7);
    expect(prompt).toMatchObject({ origin: FRAME, permission: 'geolocation' });
    broker.answer(7, prompt!.id, 'allow');
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    expect(check('geolocation', `${FRAME}/`, { isMainFrame: false, embeddingOrigin: `${TOP}/` })).toBe(true);
    expect(check('geolocation', `${TOP}/`)).toBe(false);
    // The top-level page asking for itself still prompts.
    request(TAB_CONTENTS, 'geolocation', { isMainFrame: true, requestingUrl: `${TOP}/` });
    expect(broker.promptFor(7)).toMatchObject({ origin: TOP });
  });

  test('check-handler-uses-requesting-origin', () => {
    request(TAB_CONTENTS, 'media', { isMainFrame: false, requestingUrl: `${FRAME}/`, securityOrigin: `${FRAME}/`, mediaTypes: ['video'] });
    broker.answer(7, broker.promptFor(7)!.id, 'allow');
    request(TAB_CONTENTS, 'notifications', { isMainFrame: true, requestingUrl: `${TOP}/` });
    broker.answer(7, broker.promptFor(7)!.id, 'allow');

    expect(check('notifications', `${TOP}/`)).toBe(true);
    expect(check('notifications', TOP)).toBe(true);
    expect(check('notifications', `${FRAME}/`)).toBe(false);
    expect(check('media', `${FRAME}/`, { isMainFrame: false, securityOrigin: `${FRAME}/`, mediaType: 'video' })).toBe(true);
    expect(check('media', `${FRAME}/`, { isMainFrame: false, securityOrigin: `${FRAME}/`, mediaType: 'audio' })).toBe(false);
    expect(check('media', `${FRAME}/`, { isMainFrame: false, securityOrigin: `${FRAME}/`, mediaType: 'unknown' })).toBe(false);
    expect(check('media', `${FRAME}/`, { isMainFrame: false })).toBe(false);
    for (const permission of SILENTLY_ALLOWED_PERMISSIONS) expect(check(permission, `${TOP}/`), permission).toBe(true);
    for (const permission of ['midi', 'hid', 'openExternal', 'automatic-fullscreen', 'unknown', 'camera', 'microphone']) {
      expect(check(permission, `${TOP}/`), permission).toBe(false);
    }
    for (const origin of ['null', '', 'file:///', 'app://app/']) expect(check('notifications', origin), origin).toBe(false);
  });

  test('device-permissions-stay-denied', () => {
    const plain = new FakeSession();
    hardenBrowseSession(plain as unknown as Session);
    for (const target of [ses, plain]) {
      for (const deviceType of ['hid', 'serial', 'usb'] as const) {
        expect(target.devicePermissionHandler?.({ deviceType, origin: TOP, device: {} } as never), deviceType).toBe(false);
      }
    }
  });

  test('app-session-stays-deny-all', () => {
    const appSession = session.defaultSession as unknown as FakeSession;
    registerSecurity(session.defaultSession, new FakeBrowserWindow() as unknown as BrowserWindow);
    expect(appSession).not.toBe(session.fromPartition(BROWSE_PARTITION));
    for (const permission of ['notifications', 'geolocation', 'media', 'clipboard-read', 'fullscreen', 'clipboard-sanitized-write']) {
      const callback = answerSpy();
      appSession.permissionRequestHandler?.({}, permission, callback, { isMainFrame: true, requestingUrl: 'app://app/', mediaTypes: ['video'] });
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(false);
      expect(appSession.permissionCheckHandler?.({}, permission, 'app://app/', { isMainFrame: true }), permission).toBe(false);
    }
    expect(broker.pendingCount()).toBe(0);
  });
});
