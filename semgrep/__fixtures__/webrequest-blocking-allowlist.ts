import { session, type Session } from 'electron';

declare const browse: Session;
const filter = { urls: ['http://*/*'] };

// ruleid: webrequest-blocking-outside-allowlisted-modules
browse.webRequest.onBeforeSendHeaders(filter, (_details, callback) => callback({}));
// ruleid: webrequest-blocking-outside-allowlisted-modules
browse.webRequest.onHeadersReceived(filter, (_details, callback) => callback({}));
// ruleid: webrequest-blocking-outside-allowlisted-modules
session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({}));
// ruleid: webrequest-blocking-outside-allowlisted-modules
session.fromPartition('persist:frost-browser').webRequest.onBeforeSendHeaders(null);
// ruleid: webrequest-blocking-outside-allowlisted-modules
const alias = browse.webRequest.onHeadersReceived;
// ruleid: webrequest-blocking-outside-allowlisted-modules
const viaIndex = browse.webRequest['onBeforeRequest'];
// ruleid: webrequest-blocking-outside-allowlisted-modules
const { onBeforeSendHeaders: destructured } = browse.webRequest;
// ruleid: webrequest-blocking-outside-allowlisted-modules
function registerOn({ onHeadersReceived: on }: Session['webRequest']): void {
  on(filter, (_details, callback) => callback({}));
}
// ruleid: webrequest-blocking-outside-allowlisted-modules
const arrow = ({ onBeforeRequest: on }: Session['webRequest']) => on;
let assigned: unknown;
// ruleid: webrequest-blocking-outside-allowlisted-modules
({ onBeforeSendHeaders: assigned } = browse.webRequest);
// ruleid: webrequest-blocking-outside-allowlisted-modules
const viaReflect = Reflect.get(browse.webRequest, 'onHeadersReceived');
// ruleid: webrequest-blocking-outside-allowlisted-modules
const viaDescriptor = Object.getOwnPropertyDescriptor(browse.webRequest, 'onBeforeRequest');
// ruleid: webrequest-blocking-outside-allowlisted-modules
const viaReflectDescriptor = Reflect.getOwnPropertyDescriptor(browse.webRequest, 'onBeforeSendHeaders');
// ruleid: webrequest-blocking-outside-allowlisted-modules
function untypedFunction({ onHeadersReceived: on }) {
  return on;
}
// ruleid: webrequest-blocking-outside-allowlisted-modules
const untypedArrow = ({ onBeforeRequest: on }) => on;

// The observers (`browser/web-request.ts`): they never hold a request.
// ok: webrequest-blocking-outside-allowlisted-modules
browse.webRequest.onSendHeaders(filter, () => undefined);
// ok: webrequest-blocking-outside-allowlisted-modules
browse.webRequest.onCompleted(filter, () => undefined);
// ok: webrequest-blocking-outside-allowlisted-modules
browse.webRequest.onResponseStarted(filter, () => undefined);
// ok: webrequest-blocking-outside-allowlisted-modules
const label = 'onBeforeSendHeaders';
// ok: webrequest-blocking-outside-allowlisted-modules
const viaReflectObserver = Reflect.get(browse.webRequest, 'onSendHeaders');

export { alias, arrow, assigned, destructured, label, registerOn, untypedArrow, untypedFunction, viaDescriptor, viaIndex, viaReflect, viaReflectDescriptor, viaReflectObserver };
