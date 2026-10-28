// frost's built-in SEO skills (Phase 5 Task 7; spec `specs/skills-schema.ts`, `specs/skills.spec.ts`;
// acceptance `specs/skills.feature.md`). Each is data: what it may use and what it asks, written
// here in frost's own words. Every one validates against `SkillSchema` (a test keeps it so) and is
// read-only: none may navigate, click or run code.
import type { Skill } from '@app/specs/skills-schema';
import type { BuiltinSkillId } from '@app/specs/skills.spec';

type BuiltinSkill = Skill & { readonly id: BuiltinSkillId };

export const auditThisPageSkill: BuiltinSkill = {
  id: 'audit-this-page',
  name: 'Audit this page',
  description: "Summarise this page's SEO health: its score, the most serious problems and a short, ordered list of fixes.",
  allowedTools: ['page_audit', 'page_data', 'page_text'],
  instructions: [
    'Review the SEO of the page at {{pageUrl}} (titled {{pageTitle}}).',
    '',
    'Steps:',
    "1. Read frost's audit of the page with page_audit. Use page_data for its facts and page_text only when a finding is about the content itself.",
    '2. Give the health score and say in one sentence what it mostly comes from.',
    '3. List the most serious findings first (at most six). For each: what is wrong, the value you found, and why it matters for search.',
    '4. End with a prioritised fix list of three to five items, highest impact and lowest effort first, each one concrete enough to act on.',
    '',
    'Keep it short. Report only what the tools returned; if the audit is not ready or a check could not run, say so instead of guessing.',
    'Take this note from the user into account, if one is given: {{userNote}}',
  ].join('\n'),
  inputs: [{ slot: 'userNote', label: 'Focus on (optional)', placeholder: 'For example: mobile, headings, structured data' }],
  version: 1,
};

export const rewriteTitleMetaSkill: BuiltinSkill = {
  id: 'rewrite-title-meta',
  name: 'Rewrite title and meta description',
  description: "Propose three titles and three meta descriptions for this page that fit the search snippet's length limits, with the reason for each.",
  allowedTools: ['page_data', 'page_text'],
  instructions: [
    'Write new snippet text for the page at {{pageUrl}} (titled {{pageTitle}}).',
    '',
    'Steps:',
    '1. Read the current title and meta description, with their lengths, using page_data. Skim page_text to learn what the page actually offers.',
    "2. Use the length limits the page's facts or audit state for titles and descriptions. If none are stated, keep titles to about 60 characters and descriptions to about 155, so the search engine is unlikely to cut them.",
    '3. Propose exactly three title options and exactly three meta description options. Give each one its character count and one sentence on why it would earn the click.',
    '4. Aim them at this search query, if one is given: {{targetQuery}}. If none is given, aim them at the main topic the page text shows, and say which topic you chose.',
    '',
    'Only describe what the page really contains: no claims, prices or offers the page does not make.',
    'These are suggestions for the user to apply. You cannot change the page, so never say or imply that a change was made.',
    'Take this note from the user into account, if one is given: {{userNote}}',
  ].join('\n'),
  inputs: [
    { slot: 'targetQuery', label: 'Target query (optional)', placeholder: 'The search the page should win' },
    { slot: 'userNote', label: 'Note (optional)', placeholder: 'Tone, brand name, words to avoid' },
  ],
  version: 1,
};

export const internalLinkSuggestionsSkill: BuiltinSkill = {
  id: 'internal-link-suggestions',
  name: 'Suggest internal links',
  description: "Suggest links from this page's text to other pages on the same site, each with the anchor text to use.",
  allowedTools: ['page_data', 'page_text'],
  instructions: [
    'Suggest internal links for the page at {{pageUrl}}.',
    '',
    'Steps:',
    '1. Read the page text with page_text, and the page facts (its address and link counts) with page_data.',
    '2. Find passages that talk about a topic another page on the same site covers: a page this one already links to, or one its text names. Stay on this site only.',
    '3. Suggest at most eight links. For each: the exact phrase on this page to use as anchor text, the page it should point to (its address when you know it, otherwise describe it), and one sentence on why a reader would follow it.',
    '4. Point out vague anchors this page already uses, such as "click here", when you see them.',
    '',
    'This is advice only: do not open, click or change anything, and never say a link was added.',
    'Take this note from the user into account, if one is given: {{userNote}}',
  ].join('\n'),
  inputs: [{ slot: 'userNote', label: 'Note (optional)', placeholder: 'Pages or sections to favour' }],
  version: 1,
};

/** The built-ins, in the order the skill picker lists them (`BUILTIN_SKILL_IDS`). */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [auditThisPageSkill, rewriteTitleMetaSkill, internalLinkSuggestionsSkill];
