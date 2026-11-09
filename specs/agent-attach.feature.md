# Feature: @-attach other tabs to an agent chat

Spec: `specs/agent-tools.spec.ts` (`read_attached_tab`, `ATTACHED_TAB_REFS`, `ATTACHED_TAB_PARTS`,
`MAX_CHAT_ATTACHMENTS`, `MAX_ATTACHED_READS_PER_TURN`, `ATTACHED_TAB_NOT_READY_NOTE`,
`attachedTabsPrompt`), `specs/agent-approvals.spec.ts` (`ATTACHED_TAB_TOOLS`, `grantOriginFor`,
`approvalOriginFor`, `runTargetFor`), `specs/agent-protocol.schema.ts` (`AGENT_PROTOCOL_VERSION` 10),
`specs/agent-ipc.schema.ts` (`AgentAttachableTabsInputSchema`, `AgentAttachTabInputSchema`,
`AgentDetachTabInputSchema`), `specs/agent-session.spec.ts` (`AgentAttachableTab`,
`AgentAttachmentView`, `AgentActiveChatView.attachments`, `AgentState.draftAttachments`,
`AGENT_ATTACH_RESULTS`). Phase 11 Task 9, Decision 11 (`docs/plans/phase-11-practitioner-tooling.md`).
Code: `apps/desktop/src/main/agent/tools/attached-tabs.ts`, `tools/runner.ts`, `approvals.ts`,
`session.ts`, `service.ts`; `packages/ai-skills/src/tools.ts`; `packages/ipc-contract/src/agent-router.ts`;
renderer `components/agent/AgentComposer.tsx`, `AgentChat.tsx`, `agent-view.ts`. Each line maps to one
named test.

## Decisions
- **An attached tab is a reference, read through main's broker.** The user attaches up to
  `MAX_CHAT_ATTACHMENTS` (3) open web tabs to a chat from the composer's `@` menu; each gets the
  lowest free ref (`tab-1` … `tab-3`). The model reads one only through `read_attached_tab({ ref,
  part })` (risk `read`). Attachments live in main's memory only (never stored with the chat).
  Attaching from the composer before a chat exists attaches to the new chat: a **typed** message
  from that composer moves them to the chat it starts (a skill run, the palette's included, never
  takes them); selecting another existing chat drops them; a send that is refused puts them back,
  merged with any attached meanwhile.
- **The user controls attachments.** Attach and detach are the chrome's, through sender-guarded IPC
  with strict, bounded inputs; no runtime message can attach a tab. The attachable-tabs answer lists
  main's tab id, a cut title and the origin of each open `http(s)` tab, never the chat's own tab.
  `agent.attachTab` sends back the origin the menu showed: main takes the tab's title and URL from
  one snapshot and refuses (`not-attachable`) unless the live page still shows that URL on that
  origin (at most `ATTACHMENT_ORIGIN_MAX_CHARS`).
- **The broker resolves the ref.** A ref not attached to the calling chat is refused
  (`not-allowed`). A tab that closed, or that left the URL it was attached at (fragment aside),
  answers `expired`, and **stays** `changed` / `closed` once seen so (even if it comes back) until
  the user attaches it again, which renews it under its ref. Grants, the private-page rule and the
  approval card use the **attached tab's** origin, never the chat tab's.
- **What the user accepts by attaching.** With read tools on, an attached page on a public origin
  is read without an approval card, signed-in pages included (attaching it is the user's consent);
  anything the page asks for that acts (opening a page, clicking, running code) still needs approval.
- **The model sees refs and origins, never titles.** The system prompt gains one sentence naming
  each attachment's ref and origin (`attachedTabsPrompt`); page titles stay out of the system role.
- **Background tabs.** frost audits only the tab on screen, so `part: 'audit'` serves the attached
  tab's last ready audit only when its URL is the attach URL; otherwise it answers the data
  `{ status: 'not-ready', ref, note: ATTACHED_TAB_NOT_READY_NOTE }` at once, with no approval card.
  `part: 'text'` runs the page-text reader on the attached tab's own page (`AGENT_PAGE_WORLD_ID`),
  which checks it still shows the attach URL before it reads.
- **Bounded.** At most `MAX_ATTACHED_READS_PER_TURN` (2) calls per attachment per turn.

## Scenarios (main: `apps/desktop/src/main/agent/__tests__/attached-tabs.test.ts`)
- Scenario: a ref the chat never attached is refused — `ref-not-attached-refused`
- Scenario: the attached tab navigated away — `navigated-tab-expired`
- Scenario: the attached tab closed — `closed-tab-expired`
- Scenario: no ready audit of the attach URL answers not-ready, no card — `attached-background-tab-audit-not-ready`
- Scenario: a ready audit of the attach URL is served — `attached-background-tab-audit-served-when-url-matches`
- Scenario: text is read from the attached tab's page with the exact-page check — `attached-text-reads-the-attached-tab-with-expected-page-check`
- Scenario: the grant origin is the attached tab's — `grant-origin-is-attached-tabs-origin`
- Scenario: the private-page rule uses the attached tab — `private-origin-check-uses-attached-tab`
- Scenario: reads are capped per attachment per turn — `reads-capped-per-turn`
- Scenario: output is wrapped untrusted with the attached origin as source — `output-wrapped-untrusted`
- Scenario: an attached private page always asks — `private-page-always-asks`
- Scenario: read tools switched off: an attached read asks — `read-switch-off-asks`
- Scenario: only open web tabs can be attached — `non-web-tab-not-attachable`
- Scenario: at most three attachments — `at-most-three`
- Scenario: the system prompt names refs and origins, never a page title — `system-prompt-has-no-page-title`
- Scenario: the tab left the origin the menu showed before the click — `attach-refused-when-origin-changed-since-menu`
- Scenario: an attachment seen changed stays expired after the tab returns — `changed-attachment-stays-expired-after-returning`
- Scenario: a refused send's draft merges with attachments made meanwhile — `draft-rollback-merges-with-attachments-made-meanwhile`
- Scenario: only a typed send takes the draft; another chat drops it — `draft-moves-only-on-a-typed-send-and-clears-on-another-chat`

## Scenarios (end to end and elsewhere)
- Scenario: an attached page asking to navigate still needs approval — `attached-text-cannot-escalate`
  (`approvals-end-to-end.test.ts`)
- Scenario: on the ChatGPT plan the new tool sits inside the `frost` namespace —
  `proxy-accepts-real-provider-requests (chatgpt: read_attached_tab is inside the frost namespace)`
  (`proxy-rules.test.ts`)
- Scenario: the attach procedures are sender-guarded and bounded — `agent-procedures-enforce-sender`,
  `agent-inputs-are-bounded`, `attach-procedures` (`agent-router.test.ts`)
- Scenario: the composer's `@` menu lists tabs, attaches one and shows chips as text —
  `composer-at-menu-attaches-a-tab`, `attachment-chips-render-titles-as-text` (`agent-components.test.ts`)
- Scenario: end to end with the scripted model — `attach-second-tab-and-read-it` (`e2e/agent.e2e.ts`)
