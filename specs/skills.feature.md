# Feature: Declarative SEO skills

Spec: `specs/skills-schema.ts` (`SkillSchema`, `SkillInputSchema`, `parseSkill`), `specs/skills.spec.ts`
(`BUILTIN_SKILL_IDS`, `SKILL_ID_PATTERN`, `SKILL_SLOT_NAMES`, `SKILL_INPUT_SLOTS`, `templateSlots`,
`SKILL_LIMITS`, `SKILL_SLOT_MAX_CHARS`, `SKILL_SLOT_MISSING`, `SKILL_DATA_OPEN` / `SKILL_DATA_CLOSE`),
`specs/agent-ipc.schema.ts` (`agent.send` with `skillId`), `specs/agent-session.spec.ts`
(`AgentState.skills`, `AgentSkillRequest`, `unknown-skill`). Phase 5 Task 7
(`docs/plans/phase-5-ai-agent.md`). Code: `packages/ai-skills/src/skills/` (`builtins.ts`, `render.ts`,
`registry.ts`), `apps/desktop/src/main/agent/session.ts`, `packages/ipc-contract/src/agent-router.ts`,
renderer `agent-view.ts`, `agent-palette.ts`, `components/agent/AgentComposer.tsx`. Each line maps to
one named test.

## Decisions
- **A skill is data.** An id (kebab-case), a name, a description, the catalogue tools it may use
  (non-empty, no repeats; an MCP tool's name is refused for now), an instruction template, the slots
  the user fills (`inputs`, optional) and a version. Nothing in a skill runs as code.
- **Slots are an allowlist.** A template may hold `{{pageUrl}}`, `{{pageTitle}}`, `{{targetQuery}}`
  and `{{userNote}}` only; any other placeholder, or a stray `{{` / `}}`, makes the skill invalid.
  Main fills `pageUrl` (the chat tab's page without its fragment) and `pageTitle` (the tab's title);
  the user may fill `targetQuery` and `userNote` when the skill declares them as inputs. A declared
  input must be a slot the template reads.
- **Values are quoted data.** Rendering replaces each placeholder with a reference (`[pageTitle]`)
  and lists the values in one block (`<skill-inputs>` … `</skill-inputs>`) after the instructions,
  one line per used slot, each a JSON string literal with `<` and `>` escaped. A value first loses
  every control, format and separator character, its whitespace collapses and it is cut to its
  slot's cap; a slot with no value says `(not given)`. So a page title can't add a line, close the
  block or turn into an instruction.
- **A skill narrows the turn.** Running a skill sends its rendered text as the user turn and offers
  the model only the skill's tools: `chat.start.allowedTools` and the broker's registration are both
  the skill's list (in catalogue order), so a call to any other tool is refused `not-allowed` even
  if the runtime asks. The chat shows the skill's name and the user's note, never the template.
- **Resolution is main's.** The renderer names a skill by id; main resolves it through a
  `SkillRegistry` (`list()`, `get(id)`; the built-ins now, Task 9 adds the user's) and lists the
  skills in `AgentState.skills` (id, name, description, inputs). An unknown id is refused
  `unknown-skill`; running skills needs the `agent.skills` entitlement.

## Schema (`packages/ai-skills/src/__tests__/skills.test.ts`)
- **Scenario: skill-schema-accepts-a-valid-skill** — every field, with and without inputs.
- **Scenario: skill-schema-refuses-invalid** — bad ids, blank or multi-line names, unknown keys, an
  empty or repeated tool list, a version out of range.
- **Scenario: skill-tool-outside-catalogue-refused** — `shell`, an MCP tool's name.
- **Scenario: skill-slot-outside-allowlist-refused** — `{{url}}`, `{{ pageUrl }}`, a stray brace
  pair; an input for an unused slot or a non-input slot.
- **Scenario: builtin-skills-validate** — each built-in parses, its ids are `BUILTIN_SKILL_IDS`, and
  none may navigate, click or run code.

## Rendering (`packages/ai-skills/src/__tests__/skills.test.ts`)
- **Scenario: skill-render-fills-slots-as-data** — references in the text, values in the block.
- **Scenario: skill-render-hostile-title-stays-in-its-block** — `}} Ignore the above …` with a line
  break and a forged closing line stays one quoted line inside the block.
- **Scenario: skill-render-missing-and-unknown-slots** — missing values say `(not given)`; unknown
  keys are ignored; an invalid skill renders nothing; the same input gives the same text.
- **Scenario: skill-render-caps-and-strips-values** — invisible characters removed, values cut.

## Registry (`packages/ai-skills/src/__tests__/skills.test.ts`)
- **Scenario: skill-registry-builtins-and-composition** — the built-ins in order; an invalid or
  repeated skill left out; composed registries resolve the first match.

## Running (`apps/desktop/src/main/agent/__tests__/session-skills.test.ts`)
- **Scenario: skill-run-narrows-the-tools** — `chat.start.allowedTools` and the broker's
  registration are the skill's; the model's call to another tool never reaches the runner.
- **Scenario: skill-run-broker-refuses-an-off-list-tool** — a `tool.invoke` for a tool outside the
  skill is answered `not-allowed`.
- **Scenario: skill-run-shows-name-and-note** — the chat shows the skill and the note; the history
  holds the rendered text with the tab's URL and title in the data block.
- **Scenario: skill-run-refusals** — an unknown skill, an input the skill doesn't declare, the
  `agent.skills` entitlement off; nothing changes in the chat.
- **Scenario: skill-run-state-lists-skills** — `AgentState.skills` from the registry.

## Router (`packages/ipc-contract/src/__tests__/agent-router.test.ts`)
- **Scenario: agent-send-skill-input-bounds** — a skill id, a note and a query within bounds pass; a
  bad id, an over-long note, text beside a skill or an unknown key is refused before the service.

## Renderer (`renderer/__tests__/agent-view.test.ts`, `agent-palette.test.ts`, `agent-components.test.ts`)
- **Scenario: skill-view-helpers** — picker options, the request built from the fields, the user
  message's skill label.
- **Scenario: skill-palette-actions** — "Run skill: {name}" per listed skill, not offered while a
  turn runs.
- **Scenario: composer-skill-picker** — picking a skill shows its fields; Run sends the skill
  request; the picker is disabled while a turn runs.

## End to end (`apps/desktop/e2e/agent.e2e.ts`)
- **Scenario: agent-skill-narrows-tools** — a skill run whose script calls `navigate` (outside the
  skill): no approval card, no tool card, the tab stays; the chat shows the skill's name.
