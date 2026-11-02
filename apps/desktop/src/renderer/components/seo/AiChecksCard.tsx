import { useState, type ReactNode } from 'react';
import type { SeoAudit } from '@app/seo-core';
import { AI_CHECKS_COPY as COPY } from '@app/specs/ai-checks.spec';
import type { TabState } from '@app/specs/browser.spec';
import { normalizeGscQuery } from '@app/specs/gsc.spec';
import { requestAgentPanel } from '../../agent-palette';
import { aiChecksPaletteSources } from '../../ai-checks-palette';
import { aiChecksCardView, type AiChecksAction, type AiChecksCardView, type AiJudgmentView } from '../../ai-checks-view';
import { aiChecksActions, useAiChecks } from '../../hooks/useAiChecks';
import type { ContentNotesApi } from '../../hooks/useContentNotes';
import { registerPaletteActions } from '../../palette/registry';
import { requestSettings } from '../../settings-open';
import { PageText } from './parts';
import '../../ai-checks.css';

// AI checks in the SEO sidebar (Phase 9 Task 11; spec `ai-checks.spec.ts`, `AI_CHECKS_COPY`; acceptance
// `ai-checks.feature.md`, UI): the Overview's "AI judgment" card (`AiChecksCard`) and the Content panel's
// "Quality" row (`AiChecksQuality`). Both follow main's `aiChecks.watch` for the tab and only ask:
// "Check this page" / "Check again" call `aiChecks.checkNow` from the click. While the mode is `off`
// each is one line inviting to Settings. The model's answer (Decision 17) is shown only inside the
// block that opens with "AI judgment — the page's own text can influence it"; its free texts are inert,
// bidi-isolated `PageText`, never a link, markup or an action: "Use as target" saves the suggested query
// only on the user's click, through the notes (`content.setTarget` with their generation). Nothing here
// is a rule, a score or a tone: a weak rating looks like a strong one. Palette: "Check this page with AI"
// and "AI checks: change mode…" (`ai-checks-palette.ts`).

const unregisterPaletteActions = registerPaletteActions(
  ...aiChecksPaletteSources({
    checkNow: (tabId) => aiChecksActions.checkNow(tabId),
    openSettings: (section) => void requestSettings(section),
  }),
);
import.meta.hot?.dispose(unregisterPaletteActions);

/** A button of the card: Settings, the agent's settings, or a check (`aria-disabled` while its call runs). */
function ActionButton({ action, tabId }: { readonly action: AiChecksAction; readonly tabId: number }) {
  const [busy, setBusy] = useState(false);
  const press = () => {
    if (action.kind === 'settings') return void requestSettings('ai-checks');
    if (action.kind === 'agent-settings') return requestAgentPanel({ kind: 'settings' });
    if (busy) return;
    setBusy(true);
    void aiChecksActions.checkNow(tabId, action.again).finally(() => setBusy(false));
  };
  const testId = action.kind === 'settings' ? 'ai-checks-open-settings' : action.kind === 'agent-settings' ? 'ai-checks-set-up-model' : 'ai-checks-check';
  return (
    <button type="button" className="seo-chip-button ai-judgment-action" data-testid={testId} data-again={action.again} aria-disabled={busy ? 'true' : undefined} onClick={press}>
      {action.label}
    </button>
  );
}

/** The card's frame: its title, and `data-state` / `data-reason` for what it shows. */
function Frame({ view, title, testId, children }: { readonly view: AiChecksCardView; readonly title: string; readonly testId: string; readonly children: ReactNode }) {
  return (
    <section className="seo-section ai-judgment-card" data-testid={testId} data-state={view.kind} data-reason={view.kind === 'unavailable' ? view.reason : undefined} aria-label={title}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">{title}</h3>
      </header>
      {children}
    </section>
  );
}

/** Mode `off`: one line, and the way to Settings. */
function OffLine({ view, testId, tabId }: { readonly view: Extract<AiChecksCardView, { kind: 'off' }>; readonly testId: string; readonly tabId: number }) {
  return (
    <section className="seo-section ai-judgment-card ai-judgment-off" data-testid={testId} data-state="off" data-collapsed="true" aria-label={COPY.cardTitle}>
      <p className="ai-judgment-off-line" data-testid="ai-checks-off">
        <span className="seo-note">{view.message}</span>
        <ActionButton action={view.action} tabId={tabId} />
      </p>
    </section>
  );
}

/** Every state but `ready` and `off`: frost's words only, never model text. */
function Status({ view, tabId }: { readonly view: Exclude<AiChecksCardView, { kind: 'ready' | 'off' }>; readonly tabId: number }) {
  const cost = view.kind === 'idle' || view.kind === 'unavailable' ? view.cost : null;
  const action = view.kind === 'loading' ? null : view.action;
  return (
    <>
      <p className="seo-note" data-testid="ai-checks-message">
        {view.message}
      </p>
      {cost ? (
        <p className="seo-note ai-judgment-cost" data-testid="ai-checks-cost">
          {cost}
        </p>
      ) : null}
      {action ? (
        <div className="ai-judgment-actions">
          <ActionButton action={action} tabId={tabId} />
        </div>
      ) : null}
    </>
  );
}

/** One answer of the model: frost's field name, then the value (a frost label, or inert model text). */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="ai-judgment-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Quality({ judgment }: { readonly judgment: AiJudgmentView }) {
  return (
    <Field label={COPY.fields.quality}>
      <span className="ai-judgment-value" data-testid="ai-quality" data-rating={judgment.quality.rating ?? 'unknown'}>
        {judgment.quality.label}
      </span>
      {judgment.reason !== '' ? <PageText value={judgment.reason} className="ai-judgment-reason" testId="ai-quality-reason" lines={3} /> : null}
    </Field>
  );
}

/** The labelled block: the label first, then everything the model answered, and who answered when. */
function Judgment({ judgment, children }: { readonly judgment: AiJudgmentView; readonly children: ReactNode }) {
  return (
    <div className="ai-judgment" data-testid="ai-judgment">
      <p className="ai-judgment-label" data-testid="ai-judgment-label">
        {judgment.label}
      </p>
      <dl className="ai-judgment-fields">{children}</dl>
      <p className="seo-note" data-testid="ai-checked-by">
        {judgment.checkedBy}
      </p>
      {judgment.cached ? (
        <p className="seo-note" data-testid="ai-cached">
          {judgment.cached}
        </p>
      ) : null}
    </div>
  );
}

/** The Overview's "AI judgment" card: the page type (the on-device one beside it when they differ), intent, quality and the suggested target, as text. */
export function AiChecksCard({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const state = useAiChecks(tab.id);
  const view = aiChecksCardView(state, audit.url, audit.pageType.type);
  if (view.kind === 'off') return <OffLine view={view} testId="ai-checks-card" tabId={tab.id} />;
  return (
    <Frame view={view} title={COPY.cardTitle} testId="ai-checks-card">
      {view.kind !== 'ready' ? (
        <Status view={view} tabId={tab.id} />
      ) : (
        <>
          <Judgment judgment={view.judgment}>
            <Field label={COPY.fields.pageType}>
              <span className="ai-judgment-value" data-testid="ai-page-type">
                {view.judgment.pageType.ai}
              </span>
              {view.judgment.pageType.heuristic ? (
                <span className="seo-note ai-judgment-heuristic" data-testid="ai-page-type-heuristic">
                  {view.judgment.pageType.heuristic}
                </span>
              ) : null}
            </Field>
            <Field label={COPY.fields.intent}>
              <span className="ai-judgment-value" data-testid="ai-intent">
                {view.judgment.intent}
              </span>
            </Field>
            <Quality judgment={view.judgment} />
            {view.judgment.suggestedTarget !== null ? (
              <Field label={COPY.fields.suggestedTarget}>
                <PageText value={view.judgment.suggestedTarget} className="ai-judgment-target" testId="ai-suggested-target" />
              </Field>
            ) : null}
          </Judgment>
          <div className="ai-judgment-actions">
            <ActionButton action={view.action} tabId={tab.id} />
          </div>
        </>
      )}
    </Frame>
  );
}

/**
 * The Content panel's "Quality" row: the AI's quality rating and reason, and its suggested target query
 * with "Use as target" (`url`: the page the notes are for; `notes`: the panel's notes for it).
 */
export function AiChecksQuality({ url, tab, notes }: { readonly url: string; readonly tab: TabState; readonly notes: ContentNotesApi }) {
  const state = useAiChecks(tab.id);
  const view = aiChecksCardView(state, url, null);
  if (view.kind === 'off') return <OffLine view={view} testId="ai-checks-quality" tabId={tab.id} />;
  if (view.kind !== 'ready') {
    return (
      <Frame view={view} title={COPY.qualityTitle} testId="ai-checks-quality">
        <Status view={view} tabId={tab.id} />
      </Frame>
    );
  }
  const { judgment } = view;
  const isTarget = judgment.target !== null && normalizeGscQuery(notes.query) === normalizeGscQuery(judgment.target);
  // "Use as target": the field shows it, and it is saved at once with the notes' generation.
  const use = (target: string) => {
    notes.setQuery(target);
    void notes.flush();
  };
  return (
    <Frame view={view} title={COPY.qualityTitle} testId="ai-checks-quality">
      <Judgment judgment={judgment}>
        <Quality judgment={judgment} />
        {judgment.suggestedTarget !== null && judgment.target !== null ? (
          <Field label={COPY.fields.suggestedTarget}>
            <span className="ai-judgment-target-row">
              <PageText value={judgment.suggestedTarget} className="ai-judgment-target" testId="ai-suggested-target" />
              {isTarget ? (
                <span className="ai-judgment-current" data-testid="ai-target-current">
                  {COPY.currentTarget}
                </span>
              ) : (
                <button type="button" className="seo-chip-button" data-testid="ai-use-as-target" aria-label={judgment.useAsTargetLabel ?? undefined} disabled={!notes.loaded} onClick={() => use(judgment.target!)}>
                  {COPY.useAsTarget}
                </button>
              )}
            </span>
          </Field>
        ) : null}
      </Judgment>
      <div className="ai-judgment-actions">
        <ActionButton action={view.action} tabId={tab.id} />
      </div>
    </Frame>
  );
}
