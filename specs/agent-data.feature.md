# Feature: The agent's data the user governs — grants page, stored chats, export, skills editor

Spec: `specs/agent-data.spec.ts` (grants page words, `CHAT_RETENTIONS`, `DEFAULT_CHAT_RETENTION`,
`retentionCutoff`, `CHAT_PRUNE_INTERVAL_MS`, `MAX_STORED_CHATS`, `AGENT_CHAT_TABLES`,
`AGENT_SKILL_TABLES`, `AGENT_SKILL_PREF_TABLES`, `filterSkills`, `SKILL_LIBRARY_WORDS`, `DELETE_ALL_CHATS`, `CHAT_EXPORT_FORMATS`, `CHAT_EXPORT_FORMAT_VERSION`,
`ChatExportV1`, `chatExportFileName`, `CHAT_EXPORT_RESULTS`, `AgentSkillDraft`, `AgentSkillDetail`,
`AGENT_SAVE_SKILL_RESULTS`, `SKILL_FIELD_MESSAGES`, `MAX_USER_SKILLS`, `duplicateSkillId`),
`specs/agent-ipc.schema.ts` (the Task 9 inputs), `specs/agent-session.spec.ts`
(`AgentState.grantsVersion`, `chatRetention`, `AgentSkillView.builtin`, `AgentSkillView.enabled`), `specs/skills-schema.ts`
(`SkillSchema`: every user skill is validated with it). Phase 5 Task 9
(`docs/plans/phase-5-ai-agent.md`). Code: `packages/db/src/agent-chats*.ts`,
`packages/db/src/agent-skills*.ts`, `packages/db/src/agent-skill-prefs*.ts`; `apps/desktop/src/main/agent/` `chat-record.ts`,
`chat-history.ts`, `chat-export.ts`, `user-skills.ts`, `dialogs.ts`, `session.ts`, `service.ts`;
`packages/ipc-contract/src/agent-router.ts`, `agent-service.ts`; renderer `agent-view.ts`,
`agent-actions.ts`, `components/agent/AgentGrants.tsx`, `AgentSkills.tsx`, `AgentSettings.tsx`,
`AgentChatList.tsx`. Each line maps to one named test.

## Decisions
- **Grants are the user's to see and take back.** The grants page lists every standing grant (the
  tool's label, the origin, when it was given), revokes one or all (all asks first, in the panel),
  and holds the read tools' switch. It says plainly: "A grant lets the agent use this tool on this
  site without asking. Text on that site can steer what it does there — for example, which element
  it clicks." Revoking takes effect at once (`AgentGrants.revoke` empties the cache before it writes).
- **Chats are stored locally, within a retention the user picks.** `off` (never written; chats live
  in memory until quit), `7d`, `30d`, `forever`; the default is **`30d`**: chats survive a restart
  (the point of storing them) and expire on their own, the file is the owner-only profile database,
  and it never holds a key. Main saves a chat when one of its turns ends (its history in the protocol
  shape, its display entries with the bounded tool previews) and deletes it when the user does. A
  turn's save writes only the rows after the ones stored (the whole chat after a trim, rows that
  didn't read back intact, or a gap); startup reads only the chats' own rows and a chat's messages
  are read when it is opened, sent to or exported. It prunes at startup, daily, and at once when the
  retention changes (`off` deletes every stored chat; a finite window also drops idle chats past it
  from memory). A change that would delete saved chats asks first in main's own dialog
  (`changeRetentionDialog`; `agent.setChatRetention` answers `saved | cancelled | failed`). The
  agent tables' deletes and rewrites run with `secure_delete` on for that batch only, so deleted text
  doesn't stay in the file's free pages. At most `MAX_STORED_CHATS` (50, as many
  as memory keeps): saving one more drops the least recently updated. A restored chat has no tab
  until its next message binds the active one; a time in the future reads as now; a deletion or
  "Delete all" made before the startup restore ran is not undone by it. Rows read back are validated with the protocol's own
  schemas and re-paired, so a tampered file can't put anything else in a chat.
- **"Delete all chats" asks in main's own dialog** (`DELETE_ALL_CHATS`), then deletes every chat in
  memory (stopping a running one) and on disk.
- **Export goes through main's save dialog only.** `agent.exportChat({ chatId, format })`: main
  shows `dialog.showSaveDialog` parented to the focused window (default name
  `frost-chat-<YYYY-MM-DD>.md` / `.json`), builds the text from the chat's display entries and writes
  it only to the file chosen there; it answers `saved`, `cancelled` or `failed`. The renderer never
  names a path. Markdown: a heading, the untrusted-output note, each turn, and each tool card as a
  fenced block (tool name and status in the info string; its fence longer than any backtick run
  inside). JSON: `ChatExportV1` (`kind: 'frost.agent-chat'`, `version: 1`). Neither carries a chat,
  call or approval id, an input hash or a key; tool output stays marked untrusted. Message text,
  the title and skill names are escaped (`inertMarkdown`), so an image, link or HTML a reply holds
  fetches nothing when the file is opened.
- **The user's skills are data validated by `SkillSchema` in main.** Stored as the validated JSON
  (`agent_skills`), validated again when read; composed **after** the built-ins, so a user skill can
  never take a built-in's id, and saving one with such an id is refused (`builtin-id`). `create`
  refuses an id already stored (`exists`), `update` one that isn't (`unknown-skill`), and a name
  that is a built-in's (ignoring case and spacing) is refused inline; main sets the
  version (1, then one more per edit). A refused draft answers inline errors per field in frost's own
  words (never Zod's text). Built-ins are read-only: "Duplicate to edit" stores a copy under a free
  id (`<id>-copy`, `-copy-2` …) named "<name> (copy)". The editor offers the catalogue's tools with
  their risk, the allowed `{{slot}}` list and the inputs a skill may ask for.

## Stored chats (`packages/db/src/__tests__/agent-chats.test.ts`)
- **Scenario: agent-chats-migrate** — `0031_agent_chats` creates the schema's tables; Phase 5's
  migrations `0030`–`0032` are contiguous and in order; a database with only the grants gains them.
- **Scenario: agent-chats-round-trip** — heads read most recent first, rows only when asked for,
  replaced in place (keeping its creation time), deleted one and all.
- **Scenario: agent-chats-append-only** — a later save writes only its own rows (earlier ones
  untouched); a position past what is stored is refused; replacing from a position drops what follows.
- **Scenario: agent-chats-deleted-text-leaves-the-file** — after deletes, a rewrite and an `off` prune,
  none of the text is in the file's bytes; the connection's `secure_delete` is as it was.
- **Scenario: agent-chats-capped** — only the `MAX_STORED_CHATS` most recent are kept, their rows too.
- **Scenario: agent-chats-refuse-out-of-bounds** — bad ids, titles, times, counts and rows are
  refused; tampered rows are skipped on the way out.
- **Scenario: agent-chats-prune-by-retention** — `forever` keeps all, `30d` / `7d` drop older ones,
  `off` drops every one (each counted first); a tampered time is pruned.
- **Scenario: chat-retention-preference-round-trip** — the default, each value, a tampered one.
- **Scenario: agent-chats-in-store** — persisted across opens of the session store.

## Skills table (`packages/db/src/__tests__/agent-skills.test.ts`)
- **Scenario: agent-skills-migrate** — `0032_agent_skills` creates the schema's table.
- **Scenario: agent-skills-round-trip** — stored, updated in place, deleted.
- **Scenario: agent-skills-refuse-out-of-bounds** — bad ids, oversized text, bad times; tampered
  rows skipped.
- **Scenario: agent-skills-capped** — `MAX_USER_SKILLS`, an existing one still updates.

## Session (`apps/desktop/src/main/agent/__tests__/session-data.test.ts`)
- **Scenario: chat-persists-across-restart** — a turn's chat is stored; a new session restores it
  without a tab, with its messages and tool cards; its next message binds the tab and sends the
  stored history with main's results.
- **Scenario: stored-chat-has-no-key-or-approval-id** — after an approved call, the stored rows hold
  no key, approval id or input hash.
- **Scenario: retention-off-stores-nothing** — even a chat ended before the setting loaded; the chat
  stays in memory.
- **Scenario: chat-saves-append-only** — the second turn writes only its rows; a gap makes the
  session write the whole chat.
- **Scenario: chat-loads-lazily** — startup reads only the list; sending to an unopened chat reads it
  first; rows that don't read back intact make the next save a full rewrite.
- **Scenario: retention-change-asks-before-deleting** — a longer window asks nothing; `7d` and `off`
  ask in main's dialog (kept: nothing changes) and, confirmed, delete on disk and idle in memory;
  the daily prune follows the window.
- **Scenario: restore-keeps-deletions-made-during-load** — "Delete all" before the restore ran stays.
- **Scenario: clear-browsing-data-hooks** — `forgetAgentGrants` and `deleteAllChatsUnconfirmed`, no dialog.
- **Scenario: delete-chat-and-delete-all** — one chat deleted on disk too; "Delete all" cancelled in
  main's dialog deletes nothing (a second click shares the open dialog), confirmed deletes
  everything; with no dialog, never confirmed.
- **Scenario: stored-chat-tampered-rows-dropped** — rows validated with the protocol's schemas;
  an in-progress card reads back expired; a future time reads as now; results stay paired with
  their own call.

## Grants page (`apps/desktop/src/main/agent/__tests__/session-data.test.ts`)
- **Scenario: grants-page-lists-and-revokes** — an "Always allow" is listed (label, origin, time),
  revoked one by one and all at once; `grantsVersion` rises on each change.
- **Scenario: grants-page-read-tools-switch** — read tools on and off; a non-boolean refused.

## Export (`apps/desktop/src/main/agent/__tests__/chat-export.test.ts`)
- **Scenario: export-markdown-golden** — the Markdown text, fences that can't be closed from inside.
- **Scenario: export-markdown-hostile-text-is-inert** — images, links, HTML, a forged heading and a
  fence in a reply or the title come out escaped.
- **Scenario: export-json-golden** — the `ChatExportV1` object.
- **Scenario: export-has-no-ids-hashes-or-keys** — neither format carries a chat, call or approval
  id, an input hash or the key; tool output says untrusted.
- **Scenario: export-default-file-name** — `frost-chat-<date>.md` / `.json`, local date.
- **Scenario: export-goes-through-the-save-dialog** — cancelled writes nothing; saved writes only the
  chosen file; a failed write answers `failed`; an unknown chat never opens the dialog.

## Skills editor (`apps/desktop/src/main/agent/__tests__/user-skills.test.ts`)
- **Scenario: skill-save-validates-and-stores** — stored as validated JSON, listed after the
  built-ins, detail for the editor, an edit raises the version, read back after a reload.
- **Scenario: skill-save-inline-errors** — per-field errors in frost's words; nothing stored.
- **Scenario: skill-save-refuses-builtin-ids-and-collisions** — `builtin-id`, `exists`,
  `unknown-skill`, a built-in's name; a tampered row can't take a built-in's id.
- **Scenario: skill-delete-and-duplicate** — copies under free ids, delete, the cap.
- **Scenario: skill-duplicate-ids-and-names** — `duplicateSkillId`, `duplicateSkillName` bounds.
- **Scenario: skill-editor-through-the-session** — the state's skills (built-in flag) change at
  once; a saved skill runs with its own tools; a deleted one is `unknown-skill`.

## Skills library (Phase 8 Task 5: search and switches)
Decisions (`docs/plans/phase-8-ai-complete.md`, 4 and 5):
- **A skill is on unless the user switched it off.** `agent_skill_prefs` (migration
  `0200_agent_skill_prefs`: `id`, `enabled` 0 or 1, `updated_at`) holds one row per skill the user
  switched, for built-ins and the user's own alike; no row means on. At most `SKILL_LIMITS.maxSkills`
  rows; a row for an id no skill has is pruned on load.
- **A disabled skill stays in the library** (its switch reads "Off") and leaves the composer's
  picker and the palette. `agent.send` refuses it `unknown-skill` and changes nothing.
- **A running turn finishes as it began.** The skill was rendered into the user turn and its tools
  fixed at `chat.start`, so switching it off mid-turn does not stop or narrow that turn; only the
  next send is refused.
- **A pref follows its skill.** Deleting a user skill deletes its row. Re-keying a user skill whose
  id a built-in has taken (`rekeySkill`) moves its row in the same `db.batch`; on load the re-keying
  finishes before the rows are read or pruned, so the old id's row is moved, never pruned as unknown
  first. The built-in that took the id starts on.
- **Search is the renderer's.** `filterSkills` keeps the skills whose name, description or id hold
  every word of the query, NFKC- and case-folded; the library and the composer's picker use it (no
  IPC). `agent.setSkillEnabled` takes a well-formed id and a boolean (strict), behind `enforceSender`.

Scenarios:
- **Scenario: agent-skill-prefs-migrate** (`packages/db/src/__tests__/agent-skill-prefs.test.ts`) —
  `0200` creates exactly the schema's table; `migrations-are-forward-only` holds with the prefs
  migrations spread last (the test-only fixture ids moved to `9000_` and `9001_`).
- **Scenario: agent-skill-prefs-round-trip** — set, read back, switch again (it keeps one row),
  delete; a deleted or re-keyed skill takes its row along.
- **Scenario: agent-skill-prefs-capped-and-tamper-safe** — a new id past the cap is refused and an
  existing one still switches; a malformed id or flag is refused; a tampered row is skipped on read.
- **Scenario: skill-disable-hides-from-picker-not-library** (`user-skills.test.ts`) — the library
  lists it off, the registry still resolves it, and a restart keeps it off.
- **Scenario: skill-delete-removes-its-pref** · **skill-prefs-unknown-ids-pruned-on-load** ·
  **rekeyed-disabled-skill-stays-disabled** — the row follows delete and re-key (even when the first
  candidate id is taken); unknown rows are pruned after re-keying.
- **Scenario: skill-run-refuses-a-disabled-skill** (`session-skills.test.ts`) — `unknown-skill`,
  nothing changes; switched on again, it runs. **skill-disabled-mid-turn-finishes-the-turn** — the
  running turn completes with its tools; the next send is refused.
- **Scenario: agent-set-skill-enabled-bounds** (`agent-router.test.ts`) — strict input, sender-guarded.
- **Scenario: filter-skills** (`agent-data-view.test.ts`) — folding, every word, order kept, blank keeps all.
- **Scenario: skills-library-search-and-switches** (`agent-data-components.test.ts`) — the search
  box filters the list ("No skills match" when none), each row's switch reads On or Off and sends
  `agent.setSkillEnabled`.
- **Scenario: skill-palette-lists-enabled-only** (`agent-palette.test.ts`) · **skill-picker-lists-enabled-only-and-searches**
  (`agent-view.test.ts`, `agent-components.test.ts`) — the palette and the picker leave out a switched-off skill.
- **Scenario: agent-skill-library-search-and-disable** (`apps/desktop/e2e/agent.e2e.ts`, End to end) —
  in the skills library, search for a built-in and switch it off: it stays listed with its switch
  "Off", the composer's picker no longer has it; switch it on and it comes back; after a restart on
  the same profile a switched-off skill is still off.

## Import and export (Phase 8 Task 6: skill files)
Decisions (`docs/plans/phase-8-ai-complete.md`, Task 6; spec `agent-data.spec.ts`, Skill files;
`skills-schema.ts`, `SkillFileSchema`):
- **Files go through main's dialogs only.** `agent.exportSkills({ ids | 'all-mine' })` opens main's
  save dialog (JSON filter, `skillExportFileName`) and `agent.previewSkillImport()` main's open dialog
  (JSON filter); the renderer never names a path. A dismissed dialog writes, reads and changes nothing
  (`cancelled`), and only one of these dialogs is open at a time.
- **An export is the user's skills, validated, owner-only.** The envelope `{ format: 'frost-skills',
  version: 1, exportedAt, skills }` is checked with `SkillFileSchema` first; it is written as a new
  file beside the chosen one (mode `0600`, flushed) and renamed over it, as the agent's settings file
  is, so a failed write leaves no half file. Built-ins are not exported; an id that is not one of the
  user's skills fails before any dialog opens.
- **Import reads at most `SKILL_FILE_MAX_BYTES` of strict UTF-8 JSON** (a regular file only) with
  frost's format and version: anything else is a plain refusal (`too-large`, `not-utf8`, `not-json`,
  `wrong-format`). Each entry is checked on its own with `SkillSchema`: an invalid one is listed
  `valid: false` with frost's sentence (never Zod's text, never the entry's own instructions) and can
  never be stored.
- **The review is the control.** An imported skill's instructions are sent as the user's own turn when
  it runs, so the review lists each entry's tools, `SKILL_WARNINGS.actingTools` when it lists an acting
  tool, any conflict, and its full instructions and inputs, as inert text. Nothing is stored or run
  until the user confirms; Import stays disabled until every selected entry's instructions have been
  opened on screen.
- **The review's token is single-use and expires** (`SKILL_IMPORT_TOKEN_TTL_MS`): `agent.importSkills`
  spends it whatever the answer; a cancelled, replaced or old token is `expired`.
- **Conflicts become copies, never replacements.** A built-in's id, one of the user's ids, or the id
  of an earlier valid entry in the same file gives a free `duplicateSkillId` and the name
  `duplicateSkillName`; a built-in's name gives `duplicateSkillName`. The import is refused whole
  (`limit`) if it would pass `MAX_USER_SKILLS`.
- **The router rebuilds the review field by field** (as `checkedSaveSkillResult`): fixed values,
  bounded text, catalogue tools only, the acting-tools flag recomputed from the tools; a malformed
  entry fails the whole answer.

Scenarios (`apps/desktop/src/main/agent/__tests__/skill-files.test.ts` unless noted):
- **Scenario: skill-export-writes-validated-envelope** — the chosen path only, a temporary file
  renamed into place, mode `0600`, a `SkillFileSchema` envelope of the user's skills; cancelled writes
  nothing; an unknown id never opens the dialog; a failed write leaves no file.
- **Scenario: skill-import-reads-bounded-utf8** — over-size, invalid UTF-8, not JSON, wrong `format`
  or `version` are plain refusals; a file of exactly `SKILL_FILE_MAX_BYTES` is read.
- **Scenario: skill-import-validates-each-skill** — an invalid entry is `valid: false` with frost's
  message and can't be selected or stored.
- **Scenario: skill-import-preview-carries-full-instructions** — each valid entry's instructions and
  inputs equal the file's (up to `maxInstructionChars`); the whole review within `SKILL_FILE_MAX_BYTES`.
- **Scenario: skill-import-conflicts-become-copies** — built-in id, existing id, built-in name; an id
  repeated within one file is listed `exists` from its second entry on, and imported as a copy.
- **Scenario: skill-import-token-single-use-and-expires** — spent once; expired after the TTL;
  cancelled or replaced tokens are refused.
- **Scenario: skill-import-respects-max-user-skills** — over the cap nothing is stored.
- **Scenario: skill-import-hostile-text-stays-data** — a name with bidi controls or instructions with
  a stray `}}` are refused by `SkillSchema`; instructions are previewed, never run, before confirmation.
- **Scenario: agent-skill-file-procedures-enforce-sender-and-bounds** (`agent-router.test.ts`) — every
  procedure sender-guarded, strict inputs, the review rebuilt and re-bounded.
- **Scenario: skill-import-review-sheet** (`agent-data-components.test.ts`) — each entry's tools, the
  acting-tools warning and its instructions as inert text; invalid entries not selectable; Import stays
  disabled until every selected entry's instructions have been opened.
- **Scenario: agent-skill-export-import** (`apps/desktop/e2e/agent.e2e.ts`, End to end) — export the
  user's skills (main's save dialog stubbed), import the file on a fresh profile (main's open dialog
  stubbed): the review shows the instructions, Import waits for them to be opened, and the same skills
  are listed; importing it again adds copies; a cancelled dialog changes nothing.

## Wiring (`apps/desktop/src/main/agent/__tests__/service.test.ts`)
- **Scenario: service-restores-prunes-and-composes-skills** — startup prunes under the default
  retention and restores the rest; the user's skill comes after the built-ins; a daily prune timer,
  cleared on quit.

## Router (`packages/ipc-contract/src/__tests__/agent-router.test.ts`)
- **Scenario: agent-procedures-enforce-sender** — every new procedure is sender-guarded first.
- **Scenario: agent-inputs-are-bounded** — the new inputs are strict and bounded.
- **Scenario: agent-data-procedures-call-service** — each call reaches the service; answers outside
  their fixed shapes are replaced (`failed`), extra fields dropped.

## Panel (`apps/desktop/src/renderer/__tests__/agent-data-view.test.ts`, `agent-data-components.test.ts`)
- **Scenario: grant-items** · **retention-and-export-words** · **skill-list-items** ·
  **skill-editor-draft-helpers** · **skill-save-answers** — the view model.
- **Scenario: grants-page-lists-revokes-and-confirms** — revoke one; revoke all asks in the panel; the
  read tools' switch; a new grants version reads the list again.
- **Scenario: grants-page-origin-is-text** — origins and labels are React text only.
- **Scenario: settings-retention-and-delete-all** — the retention select (main's answer: kept or
  failed), "Delete all chats", the ways to the grants page and the skills editor.
- **Scenario: chat-list-exports** — Markdown / JSON export per chat and main's answer; the retention hint.
- **Scenario: skills-list-marks-builtins** — built-ins read-only with "Duplicate to edit", "Your skill".
- **Scenario: skill-editor-duplicates-edits-and-shows-errors** — duplicate, edit, inline errors, save.
- **Scenario: skill-editor-new-and-delete** — a new skill's answer; delete asks first.

## End to end (`apps/desktop/e2e/agent.e2e.ts`)
- **Scenario: agent-skill-library-search-and-disable** — see Skills library above.
- **Scenario: agent-skill-export-import** — see Import and export above.
- **Scenario: agent-grants-revoke** — "Always allow" on an https site; the next navigate there runs
  without asking; the grants page lists it and revokes it; the next navigate asks again.
- **Scenario: agent-skill-editor-saves** — duplicate a built-in, an invalid placeholder refused
  inline, rename, save; it is "Your skill" and appears in the composer's picker.
- **Scenario: agent-chat-export-and-restore** — export cancelled and saved (main's save dialog
  stubbed in main by the test), the Markdown file's text; the chat is listed again after a restart on
  the same profile.
