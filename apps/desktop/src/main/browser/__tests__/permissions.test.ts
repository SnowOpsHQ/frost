// Spec: specs/permissions.spec.ts, specs/browser.spec.ts (PermissionPromptSchema)
// Acceptance: specs/permissions.feature.md (Decisions, Broker, Session wiring)
import type { BrowserWindow, Session } from 'electron';
import { session } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, PermissionPromptSchema } from '@app/specs/browser.spec';
import {
  MAX_COALESCED_REQUESTS,
  MAX_PENDING_PROMPTS_PER_TAB,
  MAX_PROMPT_IGNORES,
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
  requestScope,
  type PermissionBroker,
  type PermissionDecisionStore,
  type PermissionScope,
} from '../permissions';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const A = 'https://a.example';
const B = 'https://b.example:8443';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const notifications = (origin = A, topLevelOrigin = origin) => ({ origin, topLevelOrigin, permission: 'notifications' as const });
const geolocation = (origin = A, topLevelOrigin = origin) => ({ origin, topLevelOrigin, permission: 'geolocation' as const });
const media = (mediaTypes: ('video' | 'audio')[], origin = A) => ({ origin, topLevelOrigin: origin, permission: 'media' as const, mediaTypes });
const scope = (origin: string, topLevelOrigin = origin): PermissionScope => ({ origin, topLevelOrigin });

/** A permission callback that records its answers. */
const answerSpy = () => vi.fn<(granted: boolean) => void>();

function headId(broker: PermissionBroker, tabId: number): string {
  const prompt = broker.promptFor(tabId);
  if (!prompt) throw new Error(`tab ${tabId} shows no prompt`);
  return prompt.id;
}

interface FakeFrame {
  url: string;
  origin: string;
}

/** A tab's WebContents as the permission code reads it: its main frame and every frame below. */
function frameTree(main: FakeFrame, ...subframes: FakeFrame[]) {
  const mainFrame = { ...main, framesInSubtree: [] as FakeFrame[] };
  mainFrame.framesInSubtree = [mainFrame, ...subframes];
  return { mainFrame };
}

describe('decisions', () => {
  test('promptable-permissions-prompt', () => {
    for (const permission of ['geolocation', 'notifications', 'clipboard-read'] as const) {
      expect(classifyPermissionRequest(permission, { isMainFrame: true, requestingUrl: `${A}/` }), permission).toEqual({ kind: 'prompt', permission });
    }
    expect(classifyPermissionRequest('media', { isMainFrame: true, requestingUrl: `${A}/`, mediaTypes: ['video'] })).toEqual({
      kind: 'prompt',
      permission: 'media',
      mediaTypes: ['video'],
    });
    expect(PROMPTABLE_PERMISSIONS).toEqual(['geolocation', 'notifications', 'media', 'clipboard-read']);
  });

  test('silently-allowed-permissions', () => {
    expect(SILENTLY_ALLOWED_PERMISSIONS).toEqual(['fullscreen', 'clipboard-sanitized-write']);
    for (const permission of SILENTLY_ALLOWED_PERMISSIONS) {
      expect(classifyPermissionRequest(permission, { isMainFrame: true, requestingUrl: `${A}/` }), permission).toEqual({ kind: 'allow' });
      expect(classifyPermissionRequest(permission, undefined), permission).toEqual({ kind: 'allow' });
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
      expect(classifyPermissionRequest(permission, { isMainFrame: true, requestingUrl: `${A}/` }), permission).toEqual({ kind: 'deny' });
    }
  });

  test('media-split-into-camera-and-microphone', () => {
    const ask = (mediaTypes: unknown) => classifyPermissionRequest('media', { isMainFrame: true, requestingUrl: `${A}/`, mediaTypes });
    expect(ask(['audio', 'video'])).toEqual({ kind: 'prompt', permission: 'media', mediaTypes: ['video', 'audio'] });
    expect(ask(['video', 'audio', 'video'])).toEqual({ kind: 'prompt', permission: 'media', mediaTypes: ['video', 'audio'] });
    expect(ask(['video'])).toEqual({ kind: 'prompt', permission: 'media', mediaTypes: ['video'] });
    expect(ask(['audio'])).toEqual({ kind: 'prompt', permission: 'media', mediaTypes: ['audio'] });
    for (const none of [undefined, [], ['screen'], 'video', null]) expect(ask(none), String(none)).toEqual({ kind: 'deny' });
  });

  test('requesting-frame-decides-scope', () => {
    const top = { url: `${A}/page?q=1`, origin: A };
    const widget = { url: `${B}/embed?x=1`, origin: B };
    // A main frame asking for itself.
    expect(requestScope(frameTree(top), { isMainFrame: true, requestingUrl: top.url })).toEqual(scope(A));
    // A cross-origin subframe: its own origin, scoped to the top-level page.
    expect(requestScope(frameTree(top, widget), { isMainFrame: false, requestingUrl: widget.url })).toEqual(scope(B, A));
    // Several frames at the same URL, all on that origin.
    expect(requestScope(frameTree(top, widget, { ...widget }), { isMainFrame: false, requestingUrl: widget.url })).toEqual(scope(B, A));
    // Media requests carry the same requestingUrl.
    expect(requestScope(frameTree(top, widget), { isMainFrame: false, requestingUrl: widget.url, securityOrigin: `${B}/` })).toEqual(scope(B, A));

    const denied: [string, unknown, unknown][] = [
      // CSP `sandbox`: the document at an http(s) URL has an opaque origin.
      ['csp-sandboxed main frame', frameTree({ url: `${A}/sandboxed`, origin: 'null' }), { isMainFrame: true, requestingUrl: `${A}/sandboxed` }],
      // The main frame has moved on to another origin since the request was made.
      ['navigated main frame', frameTree({ url: `${B}/`, origin: B }), { isMainFrame: true, requestingUrl: `${A}/` }],
      // `<iframe sandbox>` at an allowed URL.
      ['sandboxed iframe', frameTree(top, { url: `${A}/plain`, origin: 'null' }), { isMainFrame: false, requestingUrl: `${A}/plain` }],
      ['one sandboxed among same-URL frames', frameTree(top, widget, { url: widget.url, origin: 'null' }), { isMainFrame: false, requestingUrl: widget.url }],
      ['no frame at that URL', frameTree(top, widget), { isMainFrame: false, requestingUrl: `${B}/elsewhere` }],
      ['opaque top-level page', frameTree({ url: `${A}/sandboxed`, origin: 'null' }, widget), { isMainFrame: false, requestingUrl: widget.url }],
      ['about:blank frame', frameTree(top, { url: 'about:blank', origin: A }), { isMainFrame: false, requestingUrl: 'about:blank' }],
      ['data: frame', frameTree(top, { url: 'data:text/html,x', origin: 'null' }), { isMainFrame: false, requestingUrl: 'data:text/html,x' }],
      ['file: page', frameTree({ url: 'file:///etc/passwd', origin: 'file://' }), { isMainFrame: true, requestingUrl: 'file:///etc/passwd' }],
      ['app: page', frameTree({ url: 'app://app/', origin: 'app://app' }), { isMainFrame: true, requestingUrl: 'app://app/' }],
      ['unparsable URL', frameTree(top), { isMainFrame: true, requestingUrl: 'not a url' }],
      ['missing URL', frameTree(top), { isMainFrame: true }],
      ['no details', frameTree(top), undefined],
      ['no contents', null, { isMainFrame: true, requestingUrl: top.url }],
      ['no main frame', {}, { isMainFrame: true, requestingUrl: top.url }],
      [
        'throwing main frame',
        Object.defineProperty({}, 'mainFrame', {
          get() {
            throw new Error('destroyed');
          },
        }),
        { isMainFrame: true, requestingUrl: top.url },
      ],
    ];
    for (const [name, contents, details] of denied) expect(requestScope(contents, details), name).toBeNull();
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
    expect(prompt).toMatchObject({ origin: A, topLevelOrigin: null, permission: 'notifications' });
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

  test('coalesced-requests-capped', () => {
    const coalesced = Array.from({ length: MAX_COALESCED_REQUESTS }, () => answerSpy());
    for (const callback of coalesced) broker.request(1, notifications(), callback);
    const extra = Array.from({ length: 50 }, () => answerSpy());
    for (const callback of extra) broker.request(1, notifications(), callback);
    for (const callback of extra) expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    for (const callback of coalesced) expect(callback).not.toHaveBeenCalled();
    expect(broker.pendingCount()).toBe(1);
    broker.answer(1, headId(broker, 1), 'allow');
    for (const callback of coalesced) expect(callback).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('allow-is-remembered', () => {
    const asked = answerSpy();
    const elsewhere = answerSpy();
    broker.request(1, notifications(), asked);
    broker.request(2, notifications(), elsewhere);
    expect(broker.answer(1, headId(broker, 1), 'allow')).toBe(true);
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    // The same (scope, permission) pending in another tab is settled by the remembered Allow.
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
    expect(broker.check(scope(A), 'geolocation')).toBe(false);
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

  test('repeated-dismissals-back-off', () => {
    vi.useFakeTimers();
    broker = createPermissionBroker();
    // Dismissals and timeouts both count.
    for (let i = 0; i < MAX_PROMPT_IGNORES; i++) {
      broker.request(1, notifications(), answerSpy());
      expect(broker.promptFor(1), `ignore ${i}`).not.toBeNull();
      if (i === 0) vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS);
      else broker.answer(1, headId(broker, 1), 'dismiss');
    }
    const silenced = answerSpy();
    broker.request(1, notifications(), silenced);
    expect(silenced).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(1)).toBeNull();
    // In every tab, for the rest of the session.
    const otherTab = answerSpy();
    broker.request(2, notifications(), otherTab);
    expect(otherTab).toHaveBeenCalledExactlyOnceWith(false);
    // Another permission, another scope (the same origin embedded elsewhere) still prompt.
    broker.request(1, geolocation(), answerSpy());
    expect(broker.promptFor(1)).toMatchObject({ permission: 'geolocation' });
    broker.answer(1, headId(broker, 1), 'dismiss');
    broker.request(1, notifications(A, B), answerSpy());
    expect(broker.promptFor(1)).toMatchObject({ origin: A, topLevelOrigin: B });
    // Allow / Block answers never count as ignoring.
    const decided = createPermissionBroker();
    for (let i = 0; i < MAX_PROMPT_IGNORES + 1; i++) {
      decided.request(1, notifications(`https://s${i}.example`), answerSpy());
      decided.answer(1, headId(decided, 1), i % 2 === 0 ? 'allow' : 'block');
    }
    decided.request(1, geolocation(), answerSpy());
    expect(decided.promptFor(1)).not.toBeNull();
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
    expect(broker.check(scope(B), 'notifications')).toBe(false);
    expect(broker.check(scope(A), 'geolocation')).toBe(false);
  });

  test('decisions-keyed-by-top-level-origin', () => {
    const W = 'https://widget.example';
    const S = 'https://site.example';
    const T = 'https://other-site.example';
    broker.request(1, geolocation(W, S), answerSpy());
    expect(broker.promptFor(1)).toMatchObject({ origin: W, topLevelOrigin: S });
    broker.answer(1, headId(broker, 1), 'allow');
    expect(broker.check(scope(W, S), 'geolocation')).toBe(true);
    expect(broker.check(scope(W, T), 'geolocation')).toBe(false);
    expect(broker.check(scope(W), 'geolocation')).toBe(false);
    expect(broker.check(scope(S), 'geolocation')).toBe(false);
    const underS = answerSpy();
    broker.request(2, geolocation(W, S), underS);
    expect(underS).toHaveBeenCalledExactlyOnceWith(true);
    // Under another site, or as a top-level page, the widget asks again.
    const underT = answerSpy();
    broker.request(2, geolocation(W, T), underT);
    expect(underT).not.toHaveBeenCalled();
    expect(broker.promptFor(2)).toMatchObject({ origin: W, topLevelOrigin: T });
    broker.answer(2, headId(broker, 2), 'dismiss');
    broker.request(2, geolocation(W), answerSpy());
    expect(broker.promptFor(2)).toMatchObject({ origin: W, topLevelOrigin: null });
  });

  test('media-remembers-each-device', () => {
    broker.request(1, media(['video', 'audio']), answerSpy());
    expect(broker.promptFor(1)).toMatchObject({ permission: 'media', mediaTypes: ['video', 'audio'] });
    broker.answer(1, headId(broker, 1), 'allow');
    const cameraOnly = answerSpy();
    broker.request(1, media(['video']), cameraOnly);
    expect(cameraOnly).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.check(scope(A), 'camera')).toBe(true);
    expect(broker.check(scope(A), 'microphone')).toBe(true);

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
      broker.request(1, { origin, topLevelOrigin: origin, permission }, answerSpy());
      broker.answer(1, headId(broker, 1), decision);
    };
    expect(broker.check(scope(A), 'notifications')).toBe(false);
    decide(A, 'notifications', 'dismiss');
    expect(broker.check(scope(A), 'notifications')).toBe(false);
    decide(A, 'notifications', 'allow');
    expect(broker.check(scope(A), 'notifications')).toBe(true);
    decide(B, 'geolocation', 'block');
    expect(broker.check(scope(B), 'geolocation')).toBe(false);
    expect(broker.check(scope(B), 'notifications')).toBe(false);
  });

  test('answer-rechecks-requesting-frame', () => {
    let frameStillThere = true;
    const gone = answerSpy();
    const present = answerSpy();
    broker.request(1, notifications(), gone, { isCurrent: () => frameStillThere });
    broker.request(1, notifications(), present, { isCurrent: () => true });
    frameStillThere = false;
    broker.answer(1, headId(broker, 1), 'allow');
    expect(gone).toHaveBeenCalledExactlyOnceWith(false);
    expect(present).toHaveBeenCalledExactlyOnceWith(true);
    // The user's answer for the scope the prompt named is still remembered.
    expect(broker.check(scope(A), 'notifications')).toBe(true);
    // A remembered decision answering at request time does not need a recheck later.
    const later = answerSpy();
    broker.request(1, notifications(), later, { isCurrent: () => false });
    expect(later).toHaveBeenCalledExactlyOnceWith(true);
    // Not allowed to prompt (a fullscreen tab): an undecided request is denied, pending ones stay.
    broker.request(1, geolocation(B), answerSpy());
    const hidden = answerSpy();
    broker.request(1, notifications(B), hidden, { mayPrompt: false });
    expect(hidden).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(1)).toMatchObject({ origin: B, permission: 'geolocation' });
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
    expect(broker.check(scope(A), 'notifications')).toBe(false);
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
    expect(broker.check(scope(A), 'geolocation')).toBe(false);
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
    expect(broker.check(scope(A), 'geolocation')).toBe(false);
    expect(broker.check(scope(B), 'notifications')).toBe(false);
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
    expect(broker.check(scope(A), 'notifications')).toBe(false);
    // Tab-gone denials are not the user ignoring a prompt: no back-off.
    for (let i = 0; i < MAX_PROMPT_IGNORES; i++) {
      broker.request(3, notifications('https://c.example'), answerSpy());
      broker.denyTab(3);
    }
    broker.request(3, notifications('https://c.example'), answerSpy());
    expect(broker.promptFor(3)).not.toBeNull();
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
    const key = (s: PermissionScope, permission: SitePermission) => `${s.origin} ${s.topLevelOrigin} ${permission}`;
    const saved = new Map<string, 'allow' | 'block'>([[key(scope(B), 'notifications'), 'allow']]);
    const store: PermissionDecisionStore = {
      get: vi.fn((s: PermissionScope, permission: SitePermission) => saved.get(key(s, permission))),
      set: vi.fn((s: PermissionScope, permission: SitePermission, decision: 'allow' | 'block') => {
        saved.set(key(s, permission), decision);
      }),
    };
    const custom = createPermissionBroker({ store });
    const remembered = answerSpy();
    custom.request(1, notifications(B), remembered);
    expect(remembered).toHaveBeenCalledExactlyOnceWith(true);
    expect(custom.check(scope(B), 'notifications')).toBe(true);
    custom.request(1, geolocation(A, B), answerSpy());
    custom.answer(1, headId(custom, 1), 'block');
    expect(store.set).toHaveBeenCalledExactlyOnceWith(scope(A, B), 'geolocation', 'block');
    expect(saved.get(key(scope(A, B), 'geolocation'))).toBe('block');
    // The memory store is that same interface, keyed by the whole scope.
    const memory = createMemoryDecisionStore();
    expect(memory.get(scope(A), 'camera')).toBeUndefined();
    memory.set(scope(A), 'camera', 'allow');
    expect(memory.get(scope(A), 'camera')).toBe('allow');
    expect(memory.get(scope(A, B), 'camera')).toBeUndefined();
    expect(memory.get(scope(B), 'camera')).toBeUndefined();
  });
});

describe('browse session', () => {
  const TOP = 'https://top.example';
  const FRAME = 'https://frame.example:4443';
  let broker: PermissionBroker;
  let ses: FakeSession;
  let fullscreenTabs: Set<number>;
  /** The tab's frames: the top page and a cross-origin iframe. */
  let tab: ReturnType<typeof frameTree>;

  beforeEach(() => {
    broker = createPermissionBroker();
    ses = new FakeSession();
    fullscreenTabs = new Set();
    tab = frameTree({ url: `${TOP}/page`, origin: TOP }, { url: `${FRAME}/embed?x=1`, origin: FRAME });
    const handlers = createBrowsePermissionHandlers({
      broker,
      tabIdOf: (contents) => (contents === tab ? 7 : null),
      isFullscreen: (tabId) => fullscreenTabs.has(tabId),
    });
    hardenBrowseSession(ses as unknown as Session, { permissions: handlers });
  });

  const request = (contents: unknown, permission: string, details: object) => {
    const callback = answerSpy();
    ses.permissionRequestHandler?.(contents, permission, callback, details);
    return callback;
  };
  const top = { isMainFrame: true, requestingUrl: `${TOP}/page` };
  const framed = { isMainFrame: false, requestingUrl: `${FRAME}/embed?x=1` };
  const check = (permission: string, origin: string, details: object = { isMainFrame: true }, contents: unknown = tab) =>
    ses.permissionCheckHandler?.(contents, permission, origin, details);

  test('browse-session-prompts-for-tabs', () => {
    const asked = request(tab, 'notifications', top);
    expect(asked).not.toHaveBeenCalled();
    expect(broker.promptFor(7)).toMatchObject({ origin: TOP, topLevelOrigin: null, permission: 'notifications' });
    const stranger = frameTree({ url: `${TOP}/`, origin: TOP });
    expect(request(stranger, 'notifications', top)).toHaveBeenCalledExactlyOnceWith(false);
    expect(request(null, 'geolocation', top)).toHaveBeenCalledExactlyOnceWith(false);
    expect(request(tab, 'fullscreen', top)).toHaveBeenCalledExactlyOnceWith(true);
    expect(request(tab, 'midi', top)).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.pendingCount()).toBe(1);
  });

  test('prompt-names-requesting-origin', () => {
    const asked = request(tab, 'geolocation', framed);
    const prompt = broker.promptFor(7);
    expect(prompt).toMatchObject({ origin: FRAME, topLevelOrigin: TOP, permission: 'geolocation' });
    broker.answer(7, prompt!.id, 'allow');
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    expect(check('geolocation', `${FRAME}/`, { isMainFrame: false, embeddingOrigin: `${TOP}/`, requestingUrl: `${FRAME}/embed?x=1` })).toBe(true);
    // Not for the top-level page itself, nor the same origin under another site or on its own.
    expect(check('geolocation', `${TOP}/`, { isMainFrame: true, embeddingOrigin: `${TOP}/` })).toBe(false);
    expect(check('geolocation', `${FRAME}/`, { isMainFrame: false, embeddingOrigin: 'https://elsewhere.example/' })).toBe(false);
    expect(check('geolocation', `${FRAME}/`, { isMainFrame: true, embeddingOrigin: `${FRAME}/` })).toBe(false);
    // The top-level page asking for itself still prompts.
    request(tab, 'geolocation', top);
    expect(broker.promptFor(7)).toMatchObject({ origin: TOP, topLevelOrigin: null });
  });

  test('sandboxed-document-denied', () => {
    // The site's origin, as a top-level page, is allowed notifications and geolocation.
    for (const permission of ['notifications', 'geolocation']) {
      request(tab, permission, top);
      broker.answer(7, broker.promptFor(7)!.id, 'allow');
    }
    expect(request(tab, 'notifications', top)).toHaveBeenCalledExactlyOnceWith(true);
    // The same URL served with CSP `sandbox allow-scripts`: an opaque main frame.
    tab = frameTree({ url: `${TOP}/page`, origin: 'null' });
    expect(request(tab, 'notifications', top)).toHaveBeenCalledExactlyOnceWith(false);
    // `<iframe sandbox>` at a same-origin URL.
    tab = frameTree({ url: `${TOP}/page`, origin: TOP }, { url: `${TOP}/plain`, origin: 'null' });
    expect(request(tab, 'geolocation', { isMainFrame: false, requestingUrl: `${TOP}/plain` })).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.pendingCount()).toBe(0);
  });

  test('fullscreen-tab-denies-new-prompts', () => {
    fullscreenTabs.add(7);
    expect(request(tab, 'notifications', top)).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(7)).toBeNull();
    // A remembered decision still answers (no prompt involved).
    fullscreenTabs.delete(7);
    request(tab, 'geolocation', top);
    broker.answer(7, broker.promptFor(7)!.id, 'allow');
    fullscreenTabs.add(7);
    expect(request(tab, 'geolocation', top)).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('answered-prompt-rechecks-frame', () => {
    const asked = request(tab, 'geolocation', framed);
    // The iframe navigates away before the prompt is answered.
    tab.mainFrame.framesInSubtree = [tab.mainFrame];
    broker.answer(7, broker.promptFor(7)!.id, 'allow');
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
  });

  test('check-handler-uses-requesting-origin', () => {
    request(tab, 'media', { ...framed, securityOrigin: `${FRAME}/`, mediaTypes: ['video'] });
    broker.answer(7, broker.promptFor(7)!.id, 'allow');
    request(tab, 'notifications', top);
    broker.answer(7, broker.promptFor(7)!.id, 'allow');

    expect(check('notifications', `${TOP}/`, { isMainFrame: true, embeddingOrigin: `${TOP}/` })).toBe(true);
    expect(check('notifications', TOP)).toBe(true);
    expect(check('notifications', `${TOP}/`, { isMainFrame: true }, null)).toBe(true);
    expect(check('notifications', `${FRAME}/`)).toBe(false);
    // Media checks carry no embeddingOrigin: the tab's top-level origin scopes them.
    const mediaCheck = (mediaType: string | undefined, contents: unknown = tab) =>
      check('media', `${FRAME}/`, { isMainFrame: false, securityOrigin: `${FRAME}/`, ...(mediaType ? { mediaType } : {}) }, contents);
    expect(mediaCheck('video')).toBe(true);
    expect(mediaCheck('audio')).toBe(false);
    expect(mediaCheck('unknown')).toBe(false);
    expect(mediaCheck(undefined)).toBe(false);
    expect(mediaCheck('video', frameTree({ url: 'https://elsewhere.example/', origin: 'https://elsewhere.example' }))).toBe(false);
    expect(mediaCheck('video', null)).toBe(false);
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
