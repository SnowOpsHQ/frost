/**
 * Help, keyboard shortcuts, What's New and the new-tab setup checklist (Phase 11 Task 11, SL-005,
 * SL-117, SL-118, SL-126; plan Decisions 14–15; acceptance `help.feature.md`). Plain values with no
 * Zod, so the chrome renderer can use them (its strict Trusted Types CSP blocks Zod's eval probe). The
 * release notes' schema and the `help.*` procedures' schemas are in `whats-new.schema.ts`.
 *
 * The shortcuts table is built from the shortcut constants the features already own (no second copy
 * of a key): `tabs.spec.ts`, `page-commands.spec.ts`, `command-palette.spec.ts`, `seo-sidebar.spec.ts`,
 * `devtools.spec.ts`, `browser-polish.spec.ts` and `account-settings.spec.ts`. `menu.test.ts` checks
 * it against the application menu both ways.
 *
 * Clean-room: frost's own names and words.
 */
import { SETTINGS_MENU } from './account-settings.spec';
import { FIND_SHORTCUT, FIND_STEP_SHORTCUTS, HISTORY_SHORTCUT, REOPEN_TAB_SHORTCUT } from './browser-polish.spec';
import { COMMAND_PALETTE_SHORTCUT } from './command-palette.spec';
import { DEVTOOLS_TOGGLE_SHORTCUT } from './devtools.spec';
import { RESERVED_PAGE_SHORTCUTS, UNRESERVED_PAGE_SHORTCUTS } from './page-commands.spec';
import { SIDEBAR_TOGGLE_SHORTCUT } from './seo-sidebar.spec';
import { RESERVED_TAB_SHORTCUTS } from './tabs.spec';

// ---- Shortcut notation ---------------------------------------------------------------------------

/**
 * Shortcuts are written as the features write them (`RESERVED_TAB_SHORTCUTS`): `Mod` is Cmd on macOS
 * and Ctrl elsewhere, `Ctrl` is Control everywhere, a `mac:` entry exists only on macOS and an
 * `other:` entry only off it. The functions below are pure, so main, the chrome and the tests read
 * a shortcut the same way.
 */
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/** `keys` for one platform: the `mac:` / `other:` entries of the other platform dropped, prefixes removed. */
export function shortcutKeysFor(keys: readonly string[], mac: boolean): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (key.startsWith('mac:')) {
      if (mac) out.push(key.slice(4));
    } else if (key.startsWith('other:')) {
      if (!mac) out.push(key.slice(6));
    } else out.push(key);
  }
  return out;
}

/** Splits `Mod+Shift+=` into its modifiers and key (`Mod++` is `Mod` and `+`). */
function splitCombo(combo: string): { mods: string[]; key: string } {
  const parts = combo.split('+');
  let key = parts.pop() ?? '';
  if (key === '' && parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  return { mods: parts, key };
}

/**
 * One spelling of a shortcut in spec notation, for comparing: off macOS `Ctrl` is `Mod` (the same
 * key), modifiers in `MODIFIER_ORDER`. `''` for something that is not a shortcut.
 */
export function canonicalShortcut(shortcut: string, mac: boolean): string {
  const { mods, key } = splitCombo(shortcut);
  if (key === '') return '';
  const set = new Set<string>();
  for (const mod of mods) {
    if (mod === 'Mod' || mod === 'Alt' || mod === 'Shift') set.add(mod);
    else if (mod === 'Ctrl') set.add(mac ? 'Ctrl' : 'Mod');
    else return '';
  }
  return [...MODIFIER_ORDER.filter((mod) => set.has(mod)), key].join('+');
}

/** Electron accelerator key names that the spec notation spells otherwise. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = { numadd: 'NumpadAdd', numsub: 'NumpadSubtract', num0: 'Numpad0', Esc: 'Escape' };

/**
 * An Electron accelerator (`CmdOrCtrl+Shift+T`, `Cmd+[`, `CmdOrCtrl+Plus`, `CmdOrCtrl+numadd`) in
 * canonical spec notation for `mac` (`canonicalShortcut`); `''` for one it cannot read. `Plus` is the
 * `Shift+=` key (a US layout, as `RESERVED_PAGE_SHORTCUTS` writes it).
 */
export function acceleratorToShortcut(accelerator: string, mac: boolean): string {
  const { mods, key } = splitCombo(accelerator);
  const out: string[] = [];
  for (const mod of mods) {
    if (mod === 'CmdOrCtrl' || mod === 'CommandOrControl') out.push('Mod');
    else if (mod === 'Cmd' || mod === 'Command') {
      if (!mac) return '';
      out.push('Mod');
    } else if (mod === 'Ctrl' || mod === 'Control') out.push('Ctrl');
    else if (mod === 'Alt' || mod === 'Option') out.push('Alt');
    else if (mod === 'Shift') out.push('Shift');
    else return '';
  }
  if (key === 'Plus') return canonicalShortcut([...out, 'Shift', '='].join('+'), mac);
  return canonicalShortcut([...out, ACCELERATOR_KEYS[key] ?? key].join('+'), mac);
}

/** A shortcut with no `mac:` / `other:` prefix (`Mod+/`) as an Electron accelerator (`CmdOrCtrl+/`). */
export function shortcutToAccelerator(shortcut: string): string {
  const { mods, key } = splitCombo(shortcut);
  return [...mods.map((mod) => (mod === 'Mod' ? 'CmdOrCtrl' : mod)), key].join('+');
}

// ---- The shortcuts screen -------------------------------------------------------------------------

/**
 * Opens (or closes) the keyboard shortcuts screen: Help › Keyboard Shortcuts. An application-menu
 * accelerator only, not reserved in `before-input-event` (like `HISTORY_SHORTCUT`), so a page's own
 * Mod+/ (an editor's "comment line") keeps it while the page has focus. No frost menu item, reserved
 * shortcut or chrome key handler uses it.
 */
export const SHORTCUTS_SHORTCUT = 'Mod+/' as const;

/**
 * The window shortcuts the application menu sets that no feature constant names: Close Window
 * (Mod+W is Close Tab's) and Quit (macOS: the app menu's own Cmd+Q; elsewhere Ctrl+Shift+Q).
 */
export const WINDOW_SHORTCUTS = {
  'close-window': ['Mod+Shift+W'],
  quit: ['mac:Mod+Q', 'other:Ctrl+Shift+Q'],
} as const;

/** Settings… (`SETTINGS_MENU.accelerator`) in spec notation. */
const SETTINGS_SHORTCUT = acceleratorToShortcut(SETTINGS_MENU.accelerator, false);

export interface KeyboardShortcut {
  readonly id: string;
  /** frost's own words. */
  readonly label: string;
  /** Spec notation, `mac:` / `other:` entries included (`shortcutKeysFor`). */
  readonly keys: readonly string[];
  /** `range`: shown as its first and last key (`Mod+1`–`Mod+8`), not one by one. */
  readonly display?: 'range';
}

export interface KeyboardShortcutGroup {
  readonly id: string;
  readonly label: string;
  readonly shortcuts: readonly KeyboardShortcut[];
}

/**
 * Every shortcut frost's application menu sets, in groups, in the order the screen shows them. Hidden
 * alternates (F5, the keypad's +, Ctrl+Tab on macOS) are listed with their item. The standard editing
 * keys (undo, copy, paste …) and the operating system's own window keys are not frost's and are left out.
 */
export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutGroup[] = [
  {
    id: 'tabs',
    label: 'Tabs and windows',
    shortcuts: [
      { id: 'new-tab', label: 'New tab', keys: RESERVED_TAB_SHORTCUTS['new-tab'] },
      { id: 'reopen-closed-tab', label: 'Reopen the last closed tab', keys: [REOPEN_TAB_SHORTCUT] },
      { id: 'close-tab', label: 'Close tab', keys: RESERVED_TAB_SHORTCUTS['close-tab'] },
      { id: 'next-tab', label: 'Next tab', keys: RESERVED_TAB_SHORTCUTS['next-tab'] },
      { id: 'previous-tab', label: 'Previous tab', keys: RESERVED_TAB_SHORTCUTS['previous-tab'] },
      { id: 'select-tab', label: 'Go to tab 1 to 8', keys: RESERVED_TAB_SHORTCUTS['select-tab'], display: 'range' },
      { id: 'select-last-tab', label: 'Go to the last tab', keys: RESERVED_TAB_SHORTCUTS['select-last-tab'] },
      { id: 'close-window', label: 'Close window', keys: WINDOW_SHORTCUTS['close-window'] },
      { id: 'quit', label: 'Quit frost', keys: WINDOW_SHORTCUTS.quit },
    ],
  },
  {
    id: 'page',
    label: 'Page',
    shortcuts: [
      { id: 'focus-address-bar', label: 'Go to the address bar', keys: RESERVED_TAB_SHORTCUTS['focus-address-bar'] },
      { id: 'reload', label: 'Reload', keys: RESERVED_PAGE_SHORTCUTS.reload },
      { id: 'hard-reload', label: 'Reload without the cache', keys: RESERVED_PAGE_SHORTCUTS['hard-reload'] },
      { id: 'stop', label: 'Stop loading', keys: UNRESERVED_PAGE_SHORTCUTS.stop },
      { id: 'back', label: 'Back', keys: [...RESERVED_PAGE_SHORTCUTS.back, ...UNRESERVED_PAGE_SHORTCUTS.back] },
      { id: 'forward', label: 'Forward', keys: [...RESERVED_PAGE_SHORTCUTS.forward, ...UNRESERVED_PAGE_SHORTCUTS.forward] },
      { id: 'zoom-in', label: 'Zoom in', keys: RESERVED_PAGE_SHORTCUTS['zoom-in'] },
      { id: 'zoom-out', label: 'Zoom out', keys: RESERVED_PAGE_SHORTCUTS['zoom-out'] },
      { id: 'zoom-reset', label: 'Actual size', keys: RESERVED_PAGE_SHORTCUTS['zoom-reset'] },
      { id: 'find', label: 'Find in page', keys: [FIND_SHORTCUT] },
      { id: 'find-next', label: 'Next match', keys: [FIND_STEP_SHORTCUTS.next] },
      { id: 'find-previous', label: 'Previous match', keys: [FIND_STEP_SHORTCUTS.previous] },
    ],
  },
  {
    id: 'frost',
    label: 'frost',
    shortcuts: [
      { id: 'command-palette', label: 'Command palette', keys: [COMMAND_PALETTE_SHORTCUT] },
      { id: 'seo-sidebar', label: 'SEO sidebar', keys: [SIDEBAR_TOGGLE_SHORTCUT] },
      { id: 'devtools', label: 'SEO devtools', keys: [DEVTOOLS_TOGGLE_SHORTCUT] },
      { id: 'history', label: 'History', keys: [HISTORY_SHORTCUT] },
      { id: 'settings', label: 'Settings', keys: [SETTINGS_SHORTCUT] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', keys: [SHORTCUTS_SHORTCUT] },
    ],
  },
];

/** The screen's heading and its fixed words. */
export const SHORTCUTS_TEXT = {
  title: 'Keyboard shortcuts',
  close: 'Close keyboard shortcuts',
  /** Between two keys of one shortcut. */
  or: 'or',
  note: 'Shortcuts that act on the page work while the page or the address bar has focus.',
} as const;

// ---- The Help menu --------------------------------------------------------------------------------

/**
 * The fixed pages Help opens in the system browser (Open question 8: the README, and a new issue).
 * Opened only through `resolveExternalOpen` (allowlisted `https:`, on a user gesture: a menu click or
 * a palette action), as written here: nothing is attached (no query string, no app or system data).
 */
export const HELP_URLS = {
  help: 'https://github.com/SnowOpsHQ/frost#readme',
  issue: 'https://github.com/SnowOpsHQ/frost/issues/new',
} as const;
export type HelpLink = keyof typeof HELP_URLS;

/** frost's repository: a release note's link must be a page under it (`whats-new.schema.ts`). */
export const FROST_REPOSITORY_URL = 'https://github.com/SnowOpsHQ/frost' as const;

/** What a Help menu item does (Task 12 adds `diagnostics`). */
export type HelpMenuAction = 'shortcuts' | 'whats-new' | 'link';

export interface HelpMenuItem {
  readonly id: string;
  readonly label: string;
  readonly action: HelpMenuAction;
  /** For `link`: which `HELP_URLS` page. */
  readonly link?: HelpLink;
  /** Spec notation; main sets it as the item's accelerator. */
  readonly shortcut?: string;
  /** Items of one group sit together; a separator goes between groups. */
  readonly group: number;
}

/**
 * The Help menu, last in the menu bar on every platform (`role: 'help'`: macOS adds its search field).
 * Append new items at the end (Task 12: Export Diagnostics…).
 */
export const HELP_MENU = {
  label: 'Help',
  role: 'help',
  items: [
    { id: 'help-shortcuts', label: 'Keyboard Shortcuts', action: 'shortcuts', shortcut: SHORTCUTS_SHORTCUT, group: 0 },
    { id: 'help-whats-new', label: 'What’s New', action: 'whats-new', group: 0 },
    { id: 'help-frost', label: 'frost Help', action: 'link', link: 'help', group: 1 },
    { id: 'help-report-issue', label: 'Report an Issue', action: 'link', link: 'issue', group: 1 },
  ] as readonly HelpMenuItem[],
} as const;

/** The two sheets Help opens in the chrome. */
export const HELP_SHEETS = ['shortcuts', 'whats-new'] as const;
export type HelpSheet = (typeof HELP_SHEETS)[number];

/**
 * What `help.openLink` answers: `opened` (handed to the system browser), `needs-gesture` (no live
 * click or key in the asking window: nothing opened), `unavailable` (no such link, e.g. a release
 * with no page, or a URL the external-open policy refuses: nothing opened).
 */
export const HELP_OPEN_RESULTS = ['opened', 'needs-gesture', 'unavailable'] as const;
export type HelpOpenResult = (typeof HELP_OPEN_RESULTS)[number];

/** At most this many `help.watch` calls wait at once; one more answers the oldest early. */
export const MAX_PENDING_HELP_WATCHES = 4;

/** The palette's Help actions (group `browser`). */
export const HELP_PALETTE_ACTIONS = [
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', keywords: ['keys', 'hotkeys', 'help', 'cheat sheet'] },
  { id: 'help.whats-new', label: 'What’s new in frost', keywords: ['release notes', 'changes', 'version', 'help'] },
  { id: 'help.open-help', label: 'frost Help', keywords: ['docs', 'documentation', 'readme', 'support'] },
  { id: 'help.report-issue', label: 'Report an issue', keywords: ['bug', 'feedback', 'support', 'github'] },
] as const;

/** Status lines a palette Help link answers (`HelpOpenResult` other than `opened`). */
export const HELP_LINK_NOTES: Readonly<Record<Exclude<HelpOpenResult, 'opened'>, string>> = {
  'needs-gesture': 'Click the command to open the page in your browser.',
  unavailable: 'That page couldn’t be opened.',
};

// ---- What's New -----------------------------------------------------------------------------------

/**
 * `app_settings` key: the app version whose What's New was last shown. Main shows What's New once
 * after the version changes (the stored version differs from the running one and the bundled notes
 * have an entry for the running one); a first run (nothing stored) only records the version.
 */
export const WHATS_NEW_SEEN_SETTING_KEY = 'whats_new_seen_version' as const;

/** Longest app version kept or shown. */
export const APP_VERSION_MAX_CHARS = 64;
const APP_VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `value` is an app version (`1.2.3`, `1.2.3-beta.1`), at most `APP_VERSION_MAX_CHARS`. */
export function isAppVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= APP_VERSION_MAX_CHARS && APP_VERSION_PATTERN.test(value);
}

export const WHATS_NEW_TEXT = {
  title: 'What’s new in frost',
  close: 'Close What’s new',
  /** Before the running version. */
  current: 'You’re on version',
  releaseLink: 'Release page on GitHub',
  empty: 'No release notes are bundled with this build.',
} as const;

// ---- The setup checklist --------------------------------------------------------------------------

/**
 * The new-tab page's setup checklist (Decision 15), in order. Each is derived from state the chrome
 * already reads, nothing remote: `agent` from the agent's setup (`setup.ready`), `search-console` from
 * `gsc.watch` (`connected`), `project` from `projects.list` (a project besides Unfiled), `privacy` and
 * `shortcuts` from the chrome's own record (`SETUP_CHECKLIST_STORAGE_KEY`) that the Telemetry settings
 * and the shortcuts screen were opened. Each item's button opens where it is done.
 */
export const SETUP_CHECKLIST_ITEMS = [
  { id: 'agent', label: 'Set up the AI agent', action: 'Open agent settings' },
  { id: 'search-console', label: 'Connect Search Console', action: 'Open Search Console settings' },
  { id: 'project', label: 'Create a project', action: 'Open projects' },
  { id: 'privacy', label: 'Review your privacy settings', action: 'Open privacy settings' },
  { id: 'shortcuts', label: 'Learn the keyboard shortcuts', action: 'Show shortcuts' },
] as const;
export type SetupChecklistItemId = (typeof SETUP_CHECKLIST_ITEMS)[number]['id'];

/**
 * The chrome's own `localStorage` key (app://app, like `SIDEBAR_STORAGE_KEY`): JSON
 * `{ dismissed, privacy, shortcuts }` booleans. Anything else reads as all `false`.
 */
export const SETUP_CHECKLIST_STORAGE_KEY = 'frost.setup-checklist' as const;

export const SETUP_CHECKLIST_TEXT = {
  title: 'Get started',
  dismiss: 'Hide this checklist',
  done: 'Done',
  progress: (done: number, total: number) => `${done} of ${total} done`,
} as const;
