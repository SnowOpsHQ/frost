import type { PageType } from '@app/specs/page-type.spec';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AiChecksState } from '@app/specs/ai-checks.schema';
import { modelPageUrl } from '@app/specs/agent-page-tools.spec';
import type { ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import type { AgentModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import { AI_CHECK_MODES, AI_CHECKS_COPY as COPY, type AiCheckMode, type AiCheckUnavailableReason, type AiQualityRating } from '@app/specs/ai-checks.spec';
import { INTENT_LABEL_NAMES } from '@app/specs/intent-classifier.spec';
import { PAGE_TYPE_LABELS } from '@app/specs/page-type.spec';
import { modelLabel, routeLabel } from './agent-view';
import { capQuery } from './content-view';

// AI checks as the chrome shows them (Phase 9 Task 11; spec `ai-checks.spec.ts`, `AI_CHECKS_COPY`;
// acceptance `ai-checks.feature.md`, UI). Pure: main's `AiChecksState` for the tab (`aiChecks.watch`),
// the page the panel shows and its on-device page type become what the Overview's "AI judgment" card,
// the Content panel's "Quality" row and the Settings section show. Main decides everything; the chrome
// only asks (`setMode`, `checkNow`). The model's answer is untrusted (Decision 17): its free texts
// (`qualityReason`, `suggestedTarget`) pass through unchanged, to be rendered as inert, bidi-isolated
// text under `AI_CHECKS_COPY.label`; its enums become frost's own labels. Nothing here is a rule, a score
// or an action: "Use as target" is the user's click (`target`, capped as the query field caps it).

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** The cost note: the route and model the agent settings name (`null`: not known yet). */
export function costNote(model: { readonly route: ModelRoute; readonly modelId: string; readonly modelName?: string } | null): string {
  if (model === null) return COPY.costUnknown;
  return fill(COPY.cost, { model: model.modelName ?? modelLabel(model.modelId as AgentModelId), route: routeLabel(model.route) });
}

/** What a button of the card does: open Settings on AI checks, open the agent's settings, or ask main for a check. */
export type AiChecksAction = { readonly kind: 'settings' | 'agent-settings' | 'check'; readonly label: string; readonly again: boolean };

const OPEN_SETTINGS: AiChecksAction = { kind: 'settings', label: COPY.openSettings, again: false };
const SET_UP_MODEL: AiChecksAction = { kind: 'agent-settings', label: COPY.setUpModel, again: false };
const CHECK: AiChecksAction = { kind: 'check', label: COPY.checkNow, again: false };
const CHECK_AGAIN: AiChecksAction = { kind: 'check', label: COPY.checkAgain, again: true };

/** What each reason offers: a failed check can be asked again; the guard's skips and the waits can't. */
const REASON_ACTIONS: Readonly<Record<AiCheckUnavailableReason, AiChecksAction | null>> = {
  off: OPEN_SETTINGS,
  'no-model': SET_UP_MODEL,
  'not-public': null,
  'not-anonymous': null,
  'served-pending': null,
  'busy-chat': null,
  // Automatic checks wait; "Check this page" is exempt from the cap and the backoff.
  rate: CHECK,
  refused: CHECK_AGAIN,
  'invalid-output': CHECK_AGAIN,
  network: CHECK_AGAIN,
};

export interface AiJudgmentView {
  /** `AI_CHECKS_COPY.label`: above every value below. */
  readonly label: string;
  /** The AI's page type (frost's label), and the on-device one only when it differs. */
  readonly pageType: { readonly ai: string; readonly heuristic: string | null };
  readonly intent: string;
  readonly quality: { readonly rating: AiQualityRating | null; readonly label: string };
  /** The model's reason: untrusted, inert text. */
  readonly reason: string;
  /** The model's suggested target query (untrusted, inert text), `null` when it gave none. */
  readonly suggestedTarget: string | null;
  /** What "Use as target" stores: the suggestion capped as the query field caps it. */
  readonly target: string | null;
  readonly useAsTargetLabel: string | null;
  readonly checkedBy: string;
  /** Read from an earlier check of the same input (no request was sent). */
  readonly cached: string | null;
}

export type AiChecksCardView =
  /** Main has not answered for this page yet. */
  | { readonly kind: 'loading'; readonly message: string }
  /** The mode is `off`: one line, inviting to Settings. */
  | { readonly kind: 'off'; readonly message: string; readonly action: AiChecksAction }
  | { readonly kind: 'idle' | 'queued' | 'checking'; readonly message: string; readonly cost: string | null; readonly action: AiChecksAction | null }
  | { readonly kind: 'unavailable'; readonly reason: AiCheckUnavailableReason; readonly message: string; readonly cost: string | null; readonly action: AiChecksAction | null }
  | { readonly kind: 'ready'; readonly judgment: AiJudgmentView; readonly action: AiChecksAction };

const formatTime = (ms: number): string => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));

/** The page as main keys it (its fragment and userinfo dropped), `''` for no web page. */
const pageKey = (url: string): string => modelPageUrl(url) ?? '';

/**
 * The card for `state` (`null`: not answered yet), for the page the panel shows (`url`) with its
 * on-device page type. A state or answer for another page (the tab moved on) shows as loading.
 * `chatgptModels`: the ChatGPT account's listed models (`agent.watch`'s `setup.chatgpt.models`), so a
 * plan model is named as the Settings section names it, not by its id.
 */
export function aiChecksCardView(state: AiChecksState | null, url: string, heuristic: PageType | null, chatgptModels: readonly ChatgptModelView[] = []): AiChecksCardView {
  if (state !== null && state.mode === 'off') return { kind: 'off', message: COPY.offLine, action: OPEN_SETTINGS };
  if (state === null || state.url === '' || state.url !== pageKey(url)) return { kind: 'loading', message: COPY.settings.loading };
  const cost = costNote(state.model === null ? null : { ...state.model, modelName: modelLabel(state.model.modelId as AgentModelId, chatgptModels) });
  const check = state.check;
  switch (check.status) {
    case 'idle':
      return { kind: 'idle', message: COPY.idle, cost, action: CHECK };
    case 'queued':
      return { kind: 'queued', message: COPY.queued, cost: null, action: null };
    case 'checking':
      return { kind: 'checking', message: COPY.checking, cost: null, action: null };
    case 'unavailable': {
      if (check.reason === 'off') return { kind: 'off', message: COPY.offLine, action: OPEN_SETTINGS };
      const action = REASON_ACTIONS[check.reason];
      return { kind: 'unavailable', reason: check.reason, message: COPY.reasons[check.reason], cost: action?.kind === 'check' ? cost : null, action };
    }
    case 'ready': {
      const { result } = check;
      if (result.url !== state.url) return { kind: 'loading', message: COPY.settings.loading };
      const output = result.output;
      const ai = output.pageType;
      const target = output.suggestedTarget === null ? null : capQuery(output.suggestedTarget);
      return {
        kind: 'ready',
        action: CHECK_AGAIN,
        judgment: {
          label: COPY.label,
          pageType: {
            ai: ai === null ? COPY.couldNotTell : PAGE_TYPE_LABELS[ai],
            heuristic: heuristic !== null && heuristic !== ai ? fill(COPY.heuristicPageType, { type: PAGE_TYPE_LABELS[heuristic] }) : null,
          },
          intent: output.intent === null ? COPY.couldNotTell : INTENT_LABEL_NAMES[output.intent],
          quality: { rating: output.quality, label: output.quality === null ? COPY.couldNotTell : COPY.qualities[output.quality] },
          reason: output.qualityReason,
          suggestedTarget: output.suggestedTarget,
          target,
          useAsTargetLabel: target === null ? null : fill(COPY.useAsTargetLabel, { query: target }),
          checkedBy: fill(COPY.checkedBy, { model: modelLabel(result.modelId as AgentModelId, chatgptModels), time: formatTime(result.checkedAt) }),
          cached: check.cached ? COPY.cached : null,
        },
      };
    }
  }
}

// ---- Settings ------------------------------------------------------------------------------------

export interface AiChecksModeItem {
  readonly mode: AiCheckMode;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
}

/** The three modes, `mode` (main's answer) checked; `null`: not answered yet. */
export function aiChecksModeItems(mode: AiCheckMode | null): readonly AiChecksModeItem[] | null {
  if (mode === null) return null;
  return AI_CHECK_MODES.map((value) => ({ value, copy: COPY.settings.modes[value] })).map(({ value, copy }) => ({ mode: value, label: copy.label, description: copy.description, checked: value === mode }));
}

/** The mode to show: main's answer to the last `setMode` until a newer state arrives, else the state's. */
export function shownMode(state: Pick<AiChecksState, 'version' | 'mode'> | null, answered: { readonly mode: AiCheckMode; readonly version: number } | null): AiCheckMode | null {
  if (answered !== null && (state === null || state.version <= answered.version)) return answered.mode;
  return state?.mode ?? null;
}

// ---- What the palette last saw ------------------------------------------------------------------

const latest = new Map<number, AiChecksState>();

/** Each watcher remembers the tab's last state, for the palette's "Check this page with AI". */
export function rememberAiChecks(state: AiChecksState): void {
  latest.delete(state.tabId);
  latest.set(state.tabId, state);
  while (latest.size > 32) latest.delete(latest.keys().next().value!);
}

/** Forgets a tab's state once nothing watches it (stale is worse than unknown: main decides). */
export function forgetAiChecks(tabId: number): void {
  latest.delete(tabId);
}

export function knownAiChecks(tabId: number): AiChecksState | undefined {
  return latest.get(tabId);
}
