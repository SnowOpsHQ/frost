import { useState } from 'react';
import { AI_ANSWER_ORIGIN_LABELS, AI_ANSWERS_VIEW_TEXT as TEXT } from '@app/specs/ai-answers.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { AiAnswerRecord } from '@app/specs/ai-answers.schema';
import { answerParagraphs, citationRows, domainGroups, engineLabel, viaLabel, whenText } from '../../ai-answers-view';

// One AI answer (Phase 12 Task 9; acceptance `ai-answers.feature.md`, Renderer; plan Global constraints
// "Untrusted text"). Everything from the engine is React text: the answer in plain paragraphs (no
// `innerHTML`, no markdown), each citation's title and URL as text (no anchor: only "Open in tab", for an
// `http(s)` URL, opens one, through the address bar's path), and the cited domains grouped by registrable
// domain. Citations and groups of the watched domain are marked. Delete asks first.

export interface AiAnswerProps {
  /** The answer (`id: null`: shown, not kept, as the retention is `off`). */
  readonly answer: Omit<AiAnswerRecord, 'id'> & { readonly id: number | null };
  /** The watched registrable domain (`null`: none). */
  readonly watched: string | null;
  readonly onOpenUrl: (url: string) => void;
  /** Deletes it (after the confirm); absent for an answer not kept. */
  readonly onDelete?: (() => void) | undefined;
}

export function AiAnswer({ answer, watched, onOpenUrl, onDelete }: AiAnswerProps) {
  const [confirming, setConfirming] = useState(false);
  const rows = citationRows(answer.citations, watched);
  const groups = domainGroups(answer.citations, watched);
  return (
    <article className="ai-answer" data-testid="ai-answer" aria-labelledby="ai-answer-query">
      <h3 className="ai-answer-query" id="ai-answer-query" data-testid="ai-answer-query">
        <bdi dir="auto">{answer.query}</bdi>
      </h3>
      <p className="ai-answers-note" data-testid="ai-answer-meta">
        {engineLabel(answer.engine)} · {viaLabel(answer.via)} · {whenText(answer.createdAt)} · {AI_ANSWER_ORIGIN_LABELS[answer.origin]}
      </p>
      <div className="ai-answer-text" data-testid="ai-answer-text" dir="auto">
        {answerParagraphs(answer.answer).map((line, index) => (
          <p key={index} dir="auto">
            {line}
          </p>
        ))}
      </div>
      {answer.answerTruncated ? <p className="ai-answers-note">{TEXT.truncated}</p> : null}
      <p className="ai-answers-note">{TEXT.untrustedNote}</p>

      <h4 className="ai-answer-subtitle">{TEXT.domainsTitle}</h4>
      {groups.length === 0 ? <p className="ai-answers-note">{TEXT.noCitations}</p> : null}
      <ul className="ai-answer-domains">
        {groups.map((group) => (
          <li key={group.domain} className="ai-answer-domain" data-testid="ai-answer-domain" data-watched={group.watched ? 'true' : undefined}>
            {group.domain} · {group.count}
            {group.watched ? ` · ${TEXT.watched}` : null}
          </li>
        ))}
      </ul>

      <h4 className="ai-answer-subtitle">{TEXT.citationsTitle}</h4>
      <ol className="ai-answer-citations">
        {rows.map((row, index) => (
          <li key={`${index} ${row.url}`} className="ai-answer-citation" data-testid="ai-answer-citation" data-watched={row.watched ? 'true' : undefined}>
            <span className="ai-answer-citation-text">
              {row.title !== '' ? (
                <bdi className="ai-answer-citation-title" dir="auto">
                  {row.title}
                </bdi>
              ) : null}
              <span className="ai-answer-citation-url">{row.url}</span>
              {row.watched ? <span className="visually-hidden"> ({TEXT.watched})</span> : null}
            </span>
            {row.openable ? (
              <button type="button" className="panel-button" data-testid="ai-answer-open-in-tab" onClick={() => onOpenUrl(row.url)}>
                <span>{TEXT.openInTab}</span>
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      {onDelete ? (
        <div className="ai-answers-row">
          {confirming ? (
            <span className="ai-answers-confirm" role="group" aria-label={TEXT.deleteConfirm}>
              <span className="ai-answers-note">{TEXT.deleteConfirm}</span>
              <button
                type="button"
                className="panel-button ai-answers-danger"
                data-testid="ai-answer-delete-confirm"
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
              >
                <span>{TEXT.delete}</span>
              </button>
              <button type="button" className="panel-button" data-testid="ai-answer-delete-keep" onClick={() => setConfirming(false)}>
                <span>{TEXT.keep}</span>
              </button>
            </span>
          ) : (
            <button type="button" className="panel-button" data-testid="ai-answer-delete" onClick={() => setConfirming(true)}>
              <span>{TEXT.delete}</span>
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}
