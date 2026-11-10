import { session as electronSession, type Session } from 'electron';
import { BROWSE_CLASS_PARTITIONS } from '@app/specs/browser.spec';

// The browse-class registry (spec `browser.spec.ts`, `BROWSE_CLASS_PARTITIONS`; acceptance
// `browser-chrome.feature.md`, Session classification; Phase 12 Task 10a). "Is this a tab's
// session?" has one answer, here, and every consumer in main asks it: the app-wide guard's
// classification (`security/register.ts`), main's own tab check (`index.ts`), the render-profile
// debugger, the devtools Storage tab, Clear Browsing Data and the cookies-off pair. Every
// per-session wiring (observers, guard, permission handlers, downloads) is an installer added with
// `onBrowseClassSession`, so a session registered later (Task 10b's location partitions) gets each
// one exactly as the browse session did.
//
// Members: the `BROWSE_CLASS_PARTITIONS` sessions (looked up on each question: Electron answers the
// same session per partition, and only once the app is ready), plus the sessions registered with
// `registerBrowseClassSession` (only `location/**` may call it: Task 10b). An app session (the
// default session, or one marked with `markAppSession`) is never registered. Anything else, a
// missing session, or a lookup that throws, is app content (fail closed). No other module under
// `main/` compares a session to the browse partition's (`browse-class-registry-is-the-only-test`);
// the bounded fetchers' own session (`index.ts`, Decision 11) is a lookup, not a class check.
//
// A WebContents is classified **once**, when it is first asked about, which is at its creation:
// main's `web-contents-created` listeners (`index.ts`'s and the app-wide guard's in
// `security/register.ts`, both installed before any WebContents exists) ask at once. The answer is
// recorded for its life and every later question reads the record. So a tab created on a partition before that partition was registered
// stays app content (the app pin the guard gave it) even after the registration.

/** A per-session wiring, run once on each browse-class session. */
export type BrowseClassInstaller = (session: Session) => void;

export interface BrowseClassRegistry {
  /** Whether `session` is a tab's session (a member); never throws, `false` for anything else. */
  isBrowseClassSession(session: unknown): boolean;
  /** Every member: the fixed ones first (`BROWSE_CLASS_PARTITIONS` order), then the registered ones in order. Main only, once the app is ready. */
  browseClassSessions(): Session[];
  /**
   * Runs `installer` now on every member, then keeps it for every session registered later. Each
   * installer runs once per session (adding it again runs it only where it has not run). If it throws
   * on a member, the error reaches the caller and the installer is **not** kept; adding it again
   * retries only the members it has not run on. (In main the caller is the `whenReady` chain: a throw
   * there is an unhandled rejection that stops start-up before any window opens.)
   */
  onBrowseClassSession(installer: BrowseClassInstaller): void;
  /**
   * Makes `session` browse-class (Task 10b), after running every installer on it. Refuses (throws) an
   * app session (`isAppSession`, or one marked with `markAppSession`) and anything that is not an
   * object. If an installer throws, the session stays out of the class (its WebContents keep the app
   * pin) and the error is rethrown; registering it again runs only the installers that have not run
   * on it. A member: a no-op.
   */
  registerBrowseClassSession(session: Session): void;
  /** Marks `session` as an app session (the app windows'): it can never be registered. Throws for a member. */
  markAppSession(session: Session): void;
  /**
   * `contents`' session when it is browse-class, else `null`. Decided the first time `contents` is
   * asked about (its creation, in main) and recorded for its life (a missing, throwing or other
   * session: `null`, fail closed).
   */
  browseClassSessionOf(contents: { readonly session?: unknown } | null | undefined): Session | null;
}

export interface BrowseClassRegistryOptions {
  /** The fixed members (main: the `BROWSE_CLASS_PARTITIONS` sessions). Asked each time; may throw before the app is ready. */
  readonly fixed: () => readonly Session[];
  /** Sessions that are always app sessions (main: the default session). May throw before the app is ready (then: not known to be one). */
  readonly isAppSession?: (session: Session) => boolean;
}

export function createBrowseClassRegistry(options: BrowseClassRegistryOptions): BrowseClassRegistry {
  const registered = new Set<Session>();
  const installers: BrowseClassInstaller[] = [];
  /** The installers that have run on each session. */
  const ran = new WeakMap<Session, Set<BrowseClassInstaller>>();
  /** Sessions marked as app sessions. */
  const appSessions = new WeakSet<Session>();
  /** Each WebContents' classification, recorded when it was first asked about (its creation). */
  const classified = new WeakMap<object, Session | null>();

  const isMember = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== 'object') return false;
    if (registered.has(candidate as Session)) return true;
    try {
      return options.fixed().includes(candidate as Session);
    } catch {
      return false;
    }
  };

  const isApp = (candidate: Session): boolean => {
    if (appSessions.has(candidate)) return true;
    try {
      return options.isAppSession?.(candidate) === true;
    } catch {
      return false;
    }
  };

  const members = (): Session[] => {
    const all = [...options.fixed()];
    for (const member of registered) if (!all.includes(member)) all.push(member);
    return all;
  };

  const install = (target: Session, installer: BrowseClassInstaller): void => {
    let done = ran.get(target);
    if (!done) ran.set(target, (done = new Set()));
    if (done.has(installer)) return;
    installer(target);
    done.add(installer);
  };

  const classify = (contents: object): Session | null => {
    try {
      const candidate: unknown = (contents as { readonly session?: unknown }).session;
      return isMember(candidate) ? (candidate as Session) : null;
    } catch {
      return null;
    }
  };

  return {
    isBrowseClassSession: isMember,
    browseClassSessions: members,
    onBrowseClassSession(installer) {
      for (const member of members()) install(member, installer);
      if (!installers.includes(installer)) installers.push(installer);
    },
    registerBrowseClassSession(target) {
      if (isMember(target)) return;
      if (target === null || typeof target !== 'object') throw new TypeError('browse-class: not a session');
      if (isApp(target)) throw new Error('browse-class: an app session is never browse-class');
      for (const installer of [...installers]) install(target, installer);
      registered.add(target);
    },
    markAppSession(target) {
      if (isMember(target)) throw new Error('browse-class: a browse-class session cannot be an app session');
      appSessions.add(target);
    },
    browseClassSessionOf(contents) {
      if (contents === null || typeof contents !== 'object') return null;
      if (classified.has(contents)) return classified.get(contents) ?? null;
      const found = classify(contents);
      classified.set(contents, found);
      return found;
    },
  };
}

/** Main's registry: the browse partition's session, plus whatever `location/**` registers; never the default session. */
const registry = createBrowseClassRegistry({
  fixed: () => BROWSE_CLASS_PARTITIONS.map((partition) => electronSession.fromPartition(partition)),
  isAppSession: (candidate) => candidate === electronSession.defaultSession,
});

export const isBrowseClassSession: (session: unknown) => boolean = registry.isBrowseClassSession;
export const browseClassSessions: () => Session[] = registry.browseClassSessions;
export const onBrowseClassSession: (installer: BrowseClassInstaller) => void = registry.onBrowseClassSession;
export const registerBrowseClassSession: (session: Session) => void = registry.registerBrowseClassSession;
export const markAppSession: (session: Session) => void = registry.markAppSession;

/** `contents`' session when it is browse-class, as classified at its creation, else `null` (fails closed). */
export const browseClassSessionOf: (contents: { readonly session?: unknown } | null | undefined) => Session | null = registry.browseClassSessionOf;

/** Whether `contents` is a tab's: its session was browse-class when it was created (fails closed). */
export function isBrowseClassContents(contents: { readonly session?: unknown } | null | undefined): boolean {
  return browseClassSessionOf(contents) !== null;
}
