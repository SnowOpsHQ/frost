import type { SeoAuditResponse } from '@app/seo-core';
import { pageUrlOf } from '@app/specs/agent-approvals.spec';
import {
  ATTACHABLE_TAB_TITLE_MAX_CHARS,
  ATTACHMENT_ORIGIN_MAX_CHARS,
  MAX_ATTACHABLE_TABS,
  type AgentAttachableTab,
  type AgentAttachmentState,
  type AgentAttachmentView,
  type AgentAttachResult,
} from '@app/specs/agent-session.spec';
import { ATTACHED_TAB_REFS, isAttachedTabRef, MAX_CHAT_ATTACHMENTS, type AttachedTabRef } from '@app/specs/agent-tools.spec';
import { webOrigin } from '@app/specs/web-url.spec';
import { clip } from './audit-summary';

// @-attached tabs (Phase 11 Task 9, Decision 11; acceptance `specs/agent-attach.feature.md`): the
// tabs the user attached to each chat, in main's memory only (never stored with the chat). The user
// attaches and detaches them from the chrome (the session's sender-guarded procedures); the model
// only names a ref (`tab-1` …) through `read_attached_tab`, which main's broker resolves here for the
// calling chat alone.
//
// An attachment is bound to the page the tab showed when it was attached (its URL without the
// fragment), and only if that page is still on the origin the menu showed the user. Once it is seen
// to have left that page or closed, it stays `changed` / `closed` (reads answer `expired`) even if
// the tab comes back, until the user attaches the tab again.
//
// The key `null` is the new chat the composer's next typed message starts (the composer can attach
// before a chat exists); the session moves its attachments to that chat when it is created.

/** A tab as main's tab controller lists it. */
export interface AttachedTabsTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

export interface AttachedTabsDeps {
  /** The open tabs, in strip order. */
  readonly tabs: () => readonly AttachedTabsTab[];
  /** The URL tab `tabId`'s live page shows; `null` for none or a closed tab (the broker's `tabUrl`). */
  readonly tabUrl: (tabId: number) => string | null;
  /** Every tab's live page URL at once (one pass over the pages); default: `tabUrl` per tab. */
  readonly liveUrls?: () => ReadonlyMap<number, string>;
  /** The tab's audit (`browser.seo.getAudit`); default: none ready. */
  readonly audit?: (tabId: number) => SeoAuditResponse;
}

/** What a ref resolves to: the attached tab and the page it was attached at. */
export interface AttachedTabTarget {
  readonly ref: AttachedTabRef;
  readonly tabId: number;
  /** The attach URL without its fragment (`pageUrlOf`). */
  readonly url: string;
  readonly origin: string;
}

interface Attachment extends AttachedTabTarget {
  /** The tab's title when it was attached, cut (untrusted: shown as text, never sent to the model). */
  readonly title: string;
}

/** A chat's key: its id, or `null` for the new chat. */
export type AttachmentKey = string | null;

export interface AttachedTabs {
  /** The open web tabs the user may attach to `key`'s chat: not `chatTabId`, not attached and ready. */
  attachable(key: AttachmentKey, chatTabId: number | null): AgentAttachableTab[];
  /**
   * Attaches tab `tabId` at the page it shows now, if that page is on `origin` (what the menu showed):
   * with the lowest free ref, or in place of the same tab's `changed` / `closed` attachment.
   */
  attach(key: AttachmentKey, tabId: number, chatTabId: number | null, origin: string): Exclude<AgentAttachResult, 'unknown-chat'>;
  /** Detaches `ref`; `false` if it wasn't attached. */
  detach(key: AttachmentKey, ref: unknown): boolean;
  /** The chips, in ref order, with each attachment's state now. */
  views(key: AttachmentKey): AgentAttachmentView[];
  /** Whether `key`'s chat has any attachment. */
  has(key: AttachmentKey): boolean;
  /** Refs and origins only, for the system prompt (`attachedTabsPrompt`). */
  promptTargets(key: string): { ref: AttachedTabRef; origin: string }[];
  /** The calling chat's attachment `ref`, or `null` (never another chat's, never the new chat's). */
  resolve(chatId: string, ref: unknown): AttachedTabTarget | null;
  /** Whether `target` (a `resolve` answer) is still `ready`: never again once seen `changed` or `closed`. */
  isLive(target: AttachedTabTarget): boolean;
  /** Whether frost holds a ready audit of exactly `target`'s attach URL for its tab. */
  auditReady(target: AttachedTabTarget): boolean;
  /**
   * Moves `from`'s attachments to `to` (the new chat's to the chat just created, or back after a
   * refused send), merged with any `to` already has: `from`'s keep their refs, a clash takes the
   * lowest free ref, a tab already in `to` once, at most `MAX_CHAT_ATTACHMENTS`.
   */
  move(from: AttachmentKey, to: AttachmentKey): void;
  /** Drops `key`'s attachments (the chat was deleted or dropped from memory; the draft was left). */
  forget(key: AttachmentKey): void;
  /** A string that changes whenever any chip's state would (to tell the panel); also notes `changed` / `closed` for good. */
  signature(): string;
}

/** `title` as one cut line (a chip and the menu show it as React text). */
function cleanTitle(title: unknown): string {
  return clip(typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '', ATTACHABLE_TAB_TITLE_MAX_CHARS);
}

const refOrder = (a: Attachment, b: Attachment) => ATTACHED_TAB_REFS.indexOf(a.ref) - ATTACHED_TAB_REFS.indexOf(b.ref);

/** The tabs and their live URLs, read once for a whole pass. */
interface TabsNow {
  readonly open: ReadonlySet<number>;
  readonly urlOf: (tabId: number) => string | null;
}

export function createAttachedTabs(deps: AttachedTabsDeps): AttachedTabs {
  const byKey = new Map<AttachmentKey, Attachment[]>();
  /** Attachments seen `changed` or `closed`: they stay so (a new attach replaces the object). */
  const broken = new WeakMap<Attachment, Exclude<AgentAttachmentState, 'ready'>>();
  const listOf = (key: AttachmentKey): Attachment[] => byKey.get(key) ?? [];

  const tabList = (): readonly AttachedTabsTab[] => {
    try {
      const tabs = deps.tabs();
      return Array.isArray(tabs) ? tabs : [];
    } catch {
      return [];
    }
  };
  const liveUrl = (tabId: number): string | null => {
    try {
      const url = deps.tabUrl(tabId);
      return typeof url === 'string' && url !== '' ? url : null;
    } catch {
      return null;
    }
  };
  /** One read of the tab list and (with `liveUrls`) of every page's URL. */
  const tabsNow = (): TabsNow => {
    const open = new Set(tabList().map((tab) => tab.id));
    if (deps.liveUrls === undefined) return { open, urlOf: liveUrl };
    let urls: ReadonlyMap<number, string>;
    try {
      urls = deps.liveUrls();
    } catch {
      urls = new Map();
    }
    return { open, urlOf: (tabId) => urls.get(tabId) || null };
  };
  const stateOf = (attachment: Attachment, now: TabsNow = tabsNow()): AgentAttachmentState => {
    const seen = broken.get(attachment);
    if (seen !== undefined) return seen;
    const url = now.open.has(attachment.tabId) ? now.urlOf(attachment.tabId) : null;
    const state: AgentAttachmentState = url === null ? 'closed' : pageUrlOf(url) === attachment.url ? 'ready' : 'changed';
    if (state !== 'ready') broken.set(attachment, state);
    return state;
  };
  /** The stored attachment a `resolve` answer is (the same object), else `null`. */
  const stored = (target: AttachedTabTarget): Attachment | null => {
    for (const list of byKey.values()) for (const attachment of list) if (attachment === target) return attachment;
    return null;
  };

  return {
    attachable(key, chatTabId) {
      const now = tabsNow();
      const attached = listOf(key);
      const out: AgentAttachableTab[] = [];
      for (const tab of tabList()) {
        if (out.length >= MAX_ATTACHABLE_TABS) break;
        if (tab.id === chatTabId) continue;
        // An attachment still ready is not offered again; a changed or closed one may be renewed.
        const current = attached.find((attachment) => attachment.tabId === tab.id);
        if (current !== undefined && stateOf(current, now) === 'ready') continue;
        // Web tabs only, and the title and origin from one snapshot, which the live page still shows.
        const origin = webOrigin(tab.url);
        if (origin === null || origin.length > ATTACHMENT_ORIGIN_MAX_CHARS || pageUrlOf(now.urlOf(tab.id)) !== pageUrlOf(tab.url)) continue;
        out.push({ tabId: tab.id, title: cleanTitle(tab.title), origin });
      }
      return out;
    },
    attach(key, tabId, chatTabId, shownOrigin) {
      if (tabId === chatTabId) return 'not-attachable';
      // The title and the URL from the same snapshot; the live page must show that URL, on the
      // origin the menu showed the user.
      const tab = tabList().find((item) => item.id === tabId);
      if (tab === undefined) return 'not-attachable';
      const url = pageUrlOf(tab.url);
      const origin = webOrigin(tab.url);
      if (url === null || origin === null || origin.length > ATTACHMENT_ORIGIN_MAX_CHARS || origin !== shownOrigin || pageUrlOf(liveUrl(tabId)) !== url) return 'not-attachable';
      const list = listOf(key);
      const current = list.find((attachment) => attachment.tabId === tabId);
      if (current !== undefined && stateOf(current) === 'ready') return 'already-attached';
      // Attaching a changed or closed tab again renews it under its ref.
      const ref = current?.ref ?? ATTACHED_TAB_REFS.find((candidate) => !list.some((attachment) => attachment.ref === candidate));
      if (ref === undefined || (current === undefined && list.length >= MAX_CHAT_ATTACHMENTS)) return 'full';
      const next = [...list.filter((attachment) => attachment !== current), { ref, tabId, url, origin, title: cleanTitle(tab.title) }];
      byKey.set(key, next.sort(refOrder));
      return 'attached';
    },
    detach(key, ref) {
      const list = listOf(key);
      const next = list.filter((attachment) => attachment.ref !== ref);
      if (next.length === list.length) return false;
      if (next.length === 0) byKey.delete(key);
      else byKey.set(key, next);
      return true;
    },
    views(key) {
      const now = tabsNow();
      return listOf(key).map((attachment) => ({ ref: attachment.ref, origin: attachment.origin, title: attachment.title, state: stateOf(attachment, now) }));
    },
    has: (key) => listOf(key).length > 0,
    promptTargets: (key) => listOf(key).map((attachment) => ({ ref: attachment.ref, origin: attachment.origin })),
    resolve(chatId, ref) {
      if (typeof chatId !== 'string' || !isAttachedTabRef(ref)) return null;
      // The stored object itself (read-only to callers), so `isLive` sees its `changed` / `closed`.
      return listOf(chatId).find((attachment) => attachment.ref === ref) ?? null;
    },
    isLive(target) {
      const attachment = stored(target);
      return attachment !== null && stateOf(attachment) === 'ready';
    },
    auditReady(target) {
      if (deps.audit === undefined) return false;
      try {
        const response = deps.audit(target.tabId);
        return response.status === 'ready' && pageUrlOf(response.audit.url) === target.url;
      } catch {
        return false;
      }
    },
    move(from, to) {
      if (from === to) return;
      const moving = byKey.get(from) ?? [];
      byKey.delete(from);
      if (moving.length === 0) return;
      const merged: Attachment[] = [];
      const used = new Set<AttachedTabRef>();
      for (const attachment of [...moving, ...listOf(to)]) {
        if (merged.length >= MAX_CHAT_ATTACHMENTS || merged.some((kept) => kept.tabId === attachment.tabId)) continue;
        const ref = used.has(attachment.ref) ? ATTACHED_TAB_REFS.find((candidate) => !used.has(candidate)) : attachment.ref;
        if (ref === undefined) continue;
        used.add(ref);
        const kept: Attachment = ref === attachment.ref ? attachment : { ...attachment, ref };
        const seen = broken.get(attachment);
        if (seen !== undefined) broken.set(kept, seen);
        merged.push(kept);
      }
      byKey.set(to, merged.sort(refOrder));
    },
    forget(key) {
      byKey.delete(key);
    },
    signature() {
      if (byKey.size === 0) return '';
      const now = tabsNow();
      return [...byKey.entries()].map(([key, list]) => `${key ?? ''}:${list.map((attachment) => `${attachment.ref}=${stateOf(attachment, now)}`).join(',')}`).join(';');
    },
  };
}
