# Feature: The agent's data the user governs — grants page, stored chats, export, skills editor

Spec: `specs/agent-data.spec.ts` (grants page words, `CHAT_RETENTIONS`, `DEFAULT_CHAT_RETENTION`,
`retentionCutoff`, `CHAT_PRUNE_INTERVAL_MS`, `MAX_STORED_CHATS`, `AGENT_CHAT_TABLES`,
`AGENT_SKILL_TABLES`, `DELETE_ALL_CHATS`, `CHAT_EXPORT_FORMATS`, `CHAT_EXPORT_FORMAT_VERSION`,
`ChatExportV1`, `chatExportFileName`, `CHAT_EXPORT_RESULTS`, `AgentSkillDraft`, `AgentSkillDetail`,
`AGENT_SAVE_SKILL_RESULTS`, `SKILL_FIELD_MESSAGES`, `MAX_USER_SKILLS`, `duplicateSkillId`),
`specs/agent-ipc.schema.ts` (the Task 9 inputs), `specs/agent-session.spec.ts`
(`AgentState.grantsVersion`, `chatRetention`, `AgentSkillView.builtin`), `specs/skills-schema.ts`
(`SkillSchema`: every user skill is validated with it). Phase 5 Task 9
(`docs/plans/phase-5-ai-agent.md`). Code: `packages/db/src/agent-chats*.ts`,
`packages/db/src/agent-skills*.ts`; `apps/desktop/src/main/agent/` `chat-record.ts`,
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
  shape, its display entries with the bounded tool previews) and deletes it when the user does. It
  prunes at startup, daily, and at once when the retention changes (`off` deletes every stored chat;
  a finite window also drops idle chats past it from memory). At most `MAX_STORED_CHATS` (50, as many
  as memory keeps): saving one more drops the least recently updated. A restored chat has no tab
  until its next message binds the active one. Rows read back are validated with the protocol's own
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
  call or approval id, an input hash or a key; tool output stays marked untrusted.
- **The user's skills are data validated by `SkillSchema` in main.** Stored as the validated JSON
  (`agent_skills`), validated again when read; composed **after** the built-ins, so a user skill can
  never take a built-in's id, and saving one with such an id is refused (`builtin-id`). `create`
  refuses an id already stored (`exists`), `update` one that isn't (`unknown-skill`); main sets the
  version (1, then one more per edit). A refused draft answers inline errors per field in frost's own
  words (never Zod's text). Built-ins are read-only: "Duplicate to edit" stores a copy under a free
  id (`<id>-copy`, `-copy-2` …) named "<name> (copy)". The editor offers the catalogue's tools with
  their risk, the allowed `{{slot}}` list and the inputs a skill may ask for.

## Stored chats (`packages/db/src/__tests__/agent-chats.test.ts`)
- **Scenario: agent-chats-migrate** — `0031_agent_chats` creates the schema's tables; Phase 5's
  migrations `0030`–`0032` are contiguous and in order; a database with only the grants gains them.
- **Scenario: agent-chats-round-trip** — stored, read most recent first, replaced in place (keeping
  its creation time), deleted one and all.
- **Scenario: agent-chats-capped** — only the `MAX_STORED_CHATS` most recent are kept, their rows too.
- **Scenario: agent-chats-refuse-out-of-bounds** — bad ids, titles, times, counts and rows are
  refused; tampered rows are skipped on the way out.
- **Scenario: agent-chats-prune-by-retention** — `forever` keeps all, `30d` / `7d` drop older ones,
  `off` drops every one; a tampered time is pruned.
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
- **Scenario: retention-change-prunes-at-once** — `7d` drops the older chat on disk and in memory,
  `off` drops every stored chat, the daily prune follows the window.
- **Scenario: delete-chat-and-delete-all** — one chat deleted on disk too; "Delete all" cancelled in
  main's dialog deletes nothing, confirmed deletes everything; with no dialog, never confirmed.
- **Scenario: stored-chat-tampered-rows-dropped** — rows validated with the protocol's schemas;
  an in-progress card reads back expired; results stay paired with their own call.

## Grants page (`apps/desktop/src/main/agent/__tests__/session-data.test.ts`)
- **Scenario: grants-page-lists-and-revokes** — an "Always allow" is listed (label, origin, time),
  revoked one by one and all at once; `grantsVersion` rises on each change.
- **Scenario: grants-page-read-tools-switch** — read tools on and off; a non-boolean refused.

## Export (`apps/desktop/src/main/agent/__tests__/chat-export.test.ts`)
- **Scenario: export-markdown-golden** — the Markdown text, fences that can't be closed from inside.
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
  `unknown-skill`; a tampered row can't take a built-in's id.
- **Scenario: skill-delete-and-duplicate** — copies under free ids, delete, the cap.
- **Scenario: skill-duplicate-ids-and-names** — `duplicateSkillId`, `duplicateSkillName` bounds.
- **Scenario: skill-editor-through-the-session** — the state's skills (built-in flag) change at
  once; a saved skill runs with its own tools; a deleted one is `unknown-skill`.

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
- **Scenario: settings-retention-and-delete-all** — the retention select, "Delete all chats", the
  ways to the grants page and the skills editor.
- **Scenario: chat-list-exports** — Markdown / JSON export per chat and main's answer; the retention hint.
- **Scenario: skills-list-marks-builtins** — built-ins read-only with "Duplicate to edit", "Your skill".
- **Scenario: skill-editor-duplicates-edits-and-shows-errors** — duplicate, edit, inline errors, save.
- **Scenario: skill-editor-new-and-delete** — a new skill's answer; delete asks first.

## End to end (`apps/desktop/e2e/agent.e2e.ts`)
- **Scenario: agent-grants-revoke** — "Always allow" on an https site; the next navigate there runs
  without asking; the grants page lists it and revokes it; the next navigate asks again.
- **Scenario: agent-skill-editor-saves** — duplicate a built-in, an invalid placeholder refused
  inline, rename, save; it is "Your skill" and appears in the composer's picker.
- **Scenario: agent-chat-export-and-restore** — export cancelled and saved (main's save dialog
  stubbed in main by the test), the Markdown file's text; the chat is listed again after a restart on
  the same profile.
