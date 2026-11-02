import type { AiReadinessAudit } from '@app/seo-core';
import { AI_READINESS_COPY as COPY, type AiCheckStatus } from '@app/specs/ai-readiness.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { aiReadinessPaletteSources } from '../../ai-readiness-palette';
import { aiReadinessView, type AiAssistantView, type AiCheckView, type AiRingView } from '../../ai-readiness-view';
import { CheckCircleIcon, ErrorGlyph, InfoGlyph, WarningGlyph } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { PageText, Section } from './parts';
import '../../ai-readiness.css';

// The AI-readiness section, at the top of the Visibility panel (acceptance `ai-readiness.feature.md`,
// AI readiness views): frost's score ring with "Based on k of n checks", each check with why it
// matters, and the assistants as a list (the panel is narrow), each with its crawlers' roles and
// robots.txt verdicts. It renders seo-core's `aiReadinessOf(audit, probes)` through
// `ai-readiness-view.ts`. Site text (the `/llms.txt` title, robots.txt rules) is inert `PageText`.

const unregisterPaletteActions = registerPaletteActions(...aiReadinessPaletteSources());
import.meta.hot?.dispose(unregisterPaletteActions);

const RING_RADIUS = 42;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The score as a ring (the arc's length an SVG attribute, never a style), or a dash while pending. */
export function AiScoreRing({ ring }: { readonly ring: AiRingView }) {
  const arc = ring.score === null ? 0 : (Math.max(0, Math.min(100, ring.score)) / 100) * RING_LENGTH;
  return (
    <div className="seo-ring ai-ring" data-testid="ai-readiness-ring" data-state={ring.state} data-band={ring.band ?? undefined}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="seo-ring-track" cx="50" cy="50" r={RING_RADIUS} />
        {ring.score === null ? null : <circle className="seo-ring-arc" cx="50" cy="50" r={RING_RADIUS} strokeDasharray={`${arc} ${RING_LENGTH}`} transform="rotate(-90 50 50)" />}
      </svg>
      <span className="seo-ring-value ai-ring-value" data-testid="ai-readiness-score">
        {ring.value}
      </span>
    </div>
  );
}

/** The ring, its basis and (partial only) what would complete it. */
export function AiScoreSummary({ ring, eyebrow }: { readonly ring: AiRingView; readonly eyebrow: string }) {
  return (
    <div className="ai-score">
      <AiScoreRing ring={ring} />
      <div className="seo-score-text">
        <span className="seo-eyebrow">{eyebrow}</span>
        <span className="ai-score-basis" data-testid="ai-readiness-basis">
          {ring.basis}
        </span>
        {ring.hint ? (
          <span className="seo-note" data-testid="ai-readiness-hint">
            {ring.hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A status: a glyph for pass / warn / fail; `info` and `not-checked` are neutral words, never a pass mark. */
function Status({ status, label }: { readonly status: AiCheckStatus; readonly label: string }) {
  const Glyph = status === 'pass' ? CheckCircleIcon : status === 'warn' ? WarningGlyph : status === 'fail' ? ErrorGlyph : status === 'info' ? InfoGlyph : null;
  return (
    <span className="ai-status" data-testid="ai-check-status" data-status={status}>
      {Glyph ? (
        <span className="ai-status-glyph" aria-hidden="true">
          <Glyph />
        </span>
      ) : null}
      <span className="ai-status-label">{label}</span>
    </span>
  );
}

function Check({ check }: { readonly check: AiCheckView }) {
  return (
    <li className="ai-check" data-testid="ai-check" data-check={check.id} data-status={check.status} data-scored={check.scored}>
      <div className="ai-check-head">
        <span className="ai-check-label">{check.label}</span>
        <Status status={check.status} label={check.statusLabel} />
      </div>
      {check.scored ? null : <span className="ai-check-unscored">{COPY.unscored}</span>}
      <p className="seo-note ai-check-explanation">{check.explanation}</p>
      {check.lists.map((list) => (
        <p key={list.label} className="ai-check-list">
          <span className="ai-check-list-label">{list.label}:</span> {list.tokens.join(', ')}
        </p>
      ))}
      {check.agents.length > 0 ? (
        <ul className="ai-agents" aria-label="Agents">
          {check.agents.map((agent) => (
            <li key={agent.agent} className="ai-agent" data-testid="ai-agent" data-agent={agent.agent} data-status={agent.status}>
              <span className="ai-agent-label">{agent.label}</span>
              <Status status={agent.status} label={agent.statusLabel} />
              {agent.facts.length > 0 ? <span className="seo-note ai-agent-facts">{agent.facts.join(' · ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {check.llms ? (
        <div className="ai-llms" data-testid="ai-llms">
          <p className="ai-llms-outcome">{check.llms.outcome}</p>
          {check.llms.title !== null ? (
            <p className="ai-llms-title-row">
              <span className="ai-check-list-label">{COPY.llmsTitleLabel}:</span> <PageText value={check.llms.title} testId="ai-llms-title" />
            </p>
          ) : null}
          {check.llms.findings.length > 0 ? (
            <ul className="ai-llms-findings">
              {check.llms.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {check.notes.map((note) => (
        <p key={note} className="seo-note ai-check-note">
          {note}
        </p>
      ))}
    </li>
  );
}

function Assistant({ assistant }: { readonly assistant: AiAssistantView }) {
  return (
    <li className="ai-assistant" data-testid="ai-assistant" data-assistant={assistant.id}>
      <div className="ai-assistant-head">
        <span className="ai-assistant-label">{assistant.label}</span>
        {assistant.frostModel ? (
          <span className="seo-badge ai-frost-model" data-testid="ai-frost-model">
            {COPY.frostModel}
          </span>
        ) : null}
      </div>
      {assistant.frostModel ? <p className="seo-note">{COPY.frostModelNote}</p> : null}
      <ul className="ai-crawlers">
        {assistant.crawlers.map((crawler) => (
          <li key={crawler.token} className="ai-crawler" data-testid="ai-crawler" data-token={crawler.token} data-verdict={crawler.verdict}>
            <span className="ai-crawler-token">{crawler.token}</span>
            <span className="ai-crawler-role" data-testid="ai-crawler-role">
              {crawler.role}
            </span>
            <span className="ai-crawler-verdict" data-verdict={crawler.verdict}>
              {crawler.verdictLabel}
            </span>
            {crawler.rule !== null ? (
              <span className="ai-crawler-rule">
                {COPY.disallowRule} <PageText value={crawler.rule} className="seo-mono" testId="ai-crawler-rule" />
              </span>
            ) : null}
            {crawler.notes.map((note) => (
              <span key={note} className="seo-note ai-crawler-note">
                {note}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The section for the tab's ready audit (`null`: not ready yet) and its probe run. */
export function AiReadiness({ audit, probes }: { readonly audit: AiReadinessAudit | null; readonly probes: ProbesState | null }) {
  const view = aiReadinessView(audit, probes);
  return (
    <Section title={COPY.title} testId="ai-readiness">
      <AiScoreSummary ring={view.ring} eyebrow={COPY.scoreLabel} />
      <p className="seo-note" data-testid="ai-readiness-about">
        {COPY.about}
      </p>
      {view.checks.length > 0 ? (
        <ul className="ai-checks" aria-label={COPY.checksLabel} data-testid="ai-checks">
          {view.checks.map((check) => (
            <Check key={check.id} check={check} />
          ))}
        </ul>
      ) : null}
      {view.assistants.length > 0 ? (
        <div className="ai-assistants" data-testid="ai-assistants">
          <h4 className="ai-subhead">{COPY.assistantsLabel}</h4>
          <p className="seo-note">{COPY.assistantsNote}</p>
          <ul className="ai-assistant-list">
            {view.assistants.map((assistant) => (
              <Assistant key={assistant.id} assistant={assistant} />
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
