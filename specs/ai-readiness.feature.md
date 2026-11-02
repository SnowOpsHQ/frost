# Feature: AI readiness

Spec: `specs/ai-readiness.spec.ts` (`AI_BOT_ROLES`, `AI_ROBOTS_STANCES`, `AI_BOT_IDS`, `AI_BOTS`,
`AI_BOT_VERDICTS`, `AI_ASSISTANT_SOURCES`, `AI_ASSISTANT_IDS`, `AI_ASSISTANTS`, `AI_RENDERING_NOTE`,
`AI_STANCE_NOTES`), with `specs/visibility-probes.spec.ts` (`PROBE_AGENT_IDS`, `PROBE_AGENTS`,
`PROBE_LIMITS`) and `specs/seo-indexability.spec.ts` (`ROBOTS_ALLOW_ALL_OUTCOMES`,
`ROBOTS_UNKNOWN_OUTCOMES`). Phase 9 Task 6 (the robots.txt part; the score, `llms.txt` and the UI
follow in Tasks 7 and 8); security review. Each line maps to one named test.

## Decisions
- **Separate from the SEO health score.** No AI-readiness rule is in `SEO_RULE_SPECS`, so no page's
  health score changes; blocking an AI crawler is a legitimate choice.
- **Fourteen tokens, judged with no extra request.** `AI_BOTS` lists 14 robots.txt tokens with their
  operator, role and stance. seo-core judges each against the robots.txt the audit already has
  (`PageContext.robots`) with the Indexability panel's parser and `matchRobots`, on the page's path
  (`audit.aiReadiness.bots`).
- **Only agents with a published user agent are fetched.** The visibility probes add OAI-SearchBot and
  ChatGPT-User (8 agents, so `PROBE_LIMITS.maxFetches` is 8 and `maxRequests` 32). Control tokens
  (Google-Extended, Applebot-Extended) send no requests and are never probed; Claude's tokens have
  no published user agent.
- **Roles and stances from operator documentation.** `ai-search`, `live-fetch`, `training`;
  `documented`, `may-ignore` (ChatGPT-User, Perplexity-User), `control-token`, `not-documented`
  (Bytespider). Applebot is `ai-search`. Copilot → Bingbot and Google AI → Googlebot plus
  Google-Extended are frost's model.

## Catalogue and verdicts (`packages/seo-core/src/__tests__/ai-readiness.test.ts`)
- `ai-bots-catalogue-has-14-tokens-and-known-roles` — exactly 14 entries in `AI_BOT_IDS` order, one per
  token (the table of Task 6), every role in `AI_BOT_ROLES` and stance in `AI_ROBOTS_STANCES`, every
  id its token lowercased, every docs URL `https:` or `null`; each probed bot's probe agent sends its
  token; the assistants map ChatGPT, Claude, Perplexity and Apple from their operators and Copilot and
  Google AI as frost's model.
- `ai-bots-judged-from-audit-robots` — one fixture robots.txt gives each of the 14 tokens its verdict
  on the page's path, with the deciding rule and its line; a token with no group of its own falls
  back to `*` (`fallback`); `Claude-SearchBot` is judged by its own group, not `Claude-User`'s; a
  missing file allows every token, an unreadable one is `unknown`.
- `control-tokens-never-requested` — Google-Extended and Applebot-Extended are `control-token`
  `training` tokens with no probe agent, and no probe agent sends either token; the verdicts come
  from the audit's robots.txt alone.
- `robots-pending-is-not-checked` — while robots.txt is `pending`, or when there is none, every
  verdict reads `not-checked`.
- `no-new-rule-in-catalog` — `SEO_RULE_SPECS` keeps its rules (none about AI crawlers), and a
  robots.txt blocking every AI token gives the same findings and health score as one blocking none.
