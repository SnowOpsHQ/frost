import type { ChatgptFailure } from '@app/specs/agent-chatgpt.spec';
import { isUsableModelSettings } from '@app/specs/agent-proxy.spec';
import type { AgentChatgptView } from '@app/specs/agent-session.spec';
import type { AgentSettings } from '../settings';
import type { ChatgptAuth } from './service';

// The ChatGPT plan route as the rest of main sees it (plan `docs/plans/agent-chatgpt-plan.md`, Task 3
// and decision 5; acceptance `agent-chatgpt.feature.md`, Through the proxy): the sign-in service
// (`./service`), the account's model list (asked for on sign-in and when the signed-in account or
// its plan usage changes, and once at start; kept with the settings, so a restart without network
// keeps the choice), whether a turn may start on the route, and the plan failures the model proxy
// reports for the session to show. No Electron import.

export interface ChatgptRouteDeps {
  readonly auth: ChatgptAuth;
  readonly settings: Pick<AgentSettings, 'current' | 'chatgptModels' | 'setChatgptModels'>;
  /** Fixed lines only. */
  readonly log?: (line: string) => void;
}

export interface ChatgptRoute {
  /** The sign-in (Task 5's procedures use it; the proxy its `withAccessToken`). */
  readonly auth: ChatgptAuth;
  /** The account as the renderer may see it, and the last model list. */
  view(): AgentChatgptView;
  /** Whether a turn may start on the route: signed in, plan usage on, and the chosen model in the last list. */
  ready(): boolean;
  /** Asks the account for its models and keeps the list (`false`: not asked, failed, or not stored; the last list stays). */
  refreshModels(): Promise<boolean>;
  /** The account's view or its model list changed. */
  onChange(listener: () => void): () => void;
  /**
   * The account itself changed: its state, email or plan usage (a sign-in, a sign-out, an expiry,
   * re-consent, another account); not a token refresh. The model proxy lifts a plan pause on it.
   */
  onAccountChange(listener: () => void): () => void;
  /** The model proxy's report of a plan failure for the running turn. */
  report(failure: ChatgptFailure): void;
  onFailure(listener: (failure: ChatgptFailure) => void): () => void;
  /** Reads the stored sign-in, then keeps the model list current. */
  start(): Promise<void>;
  /** Stops listening and lets the sign-in finish what it started. */
  dispose(): Promise<void>;
}

export function createChatgptRoute(deps: ChatgptRouteDeps): ChatgptRoute {
  const log = deps.log ?? (() => undefined);
  const listeners = new Set<() => void>();
  const failureListeners = new Set<(failure: ChatgptFailure) => void>();
  const accountListeners = new Set<() => void>();
  /** The account as last seen (`state email planUsage`; `null` before `start`). */
  let account: string | null = null;
  let refreshing: Promise<boolean> | null = null;
  /** The signed-in account with plan usage on, as last seen (`null`: not usable): a change asks for the models. */
  let usable: string | null = null;
  let unsubscribe: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent chatgpt: a change listener failed');
      }
    }
  };

  const usableKey = (): string | null => {
    const account = deps.auth.view();
    return account.state === 'signed-in' && account.planUsage === 'on' ? `signed-in ${account.email ?? ''}` : null;
  };

  const refreshModels = (): Promise<boolean> => {
    refreshing ??= (async () => {
      const listed = await deps.auth.listModels();
      if (!listed.ok) {
        log(`agent chatgpt: the model list could not be read (${listed.reason}); the last one is kept`);
        return false;
      }
      // An empty list (or one with nothing usable left after filtering) is not a list to keep: it
      // would make the user's choice unusable until the next good read. The last list stays.
      if (listed.models.length === 0) {
        log('agent chatgpt: the model list came back empty; the last one is kept');
        return false;
      }
      const stored = await deps.settings.setChatgptModels(listed.models).catch(() => false);
      if (!stored) log('agent chatgpt: the model list could not be stored');
      notify();
      return stored;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  /** On a change of the sign-in: the list is asked for when an account becomes usable (or another does). */
  const onAuthChange = (): void => {
    const view = deps.auth.view();
    const accountKey = `${view.state} ${view.email ?? ''} ${view.planUsage ?? ''}`;
    const accountChanged = account !== null && accountKey !== account;
    account = accountKey;
    if (accountChanged) {
      for (const listener of [...accountListeners]) {
        try {
          listener();
        } catch {
          log('agent chatgpt: an account listener failed');
        }
      }
    }
    const key = usableKey();
    const changed = key !== null && key !== usable;
    usable = key;
    notify();
    if (changed) void refreshModels();
  };

  return {
    auth: deps.auth,
    view: () => ({ account: deps.auth.view(), models: deps.settings.chatgptModels() }),
    ready() {
      const account = deps.auth.view();
      return account.state === 'signed-in' && account.planUsage === 'on' && deps.settings.current().route === 'chatgpt' && isUsableModelSettings(deps.settings.current(), deps.settings.chatgptModels());
    },
    refreshModels,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onAccountChange(listener) {
      accountListeners.add(listener);
      return () => void accountListeners.delete(listener);
    },
    report(failure) {
      for (const listener of [...failureListeners]) {
        try {
          listener(failure);
        } catch {
          log('agent chatgpt: a failure listener failed');
        }
      }
    },
    onFailure(listener) {
      failureListeners.add(listener);
      return () => void failureListeners.delete(listener);
    },
    async start() {
      unsubscribe ??= deps.auth.onChange(onAuthChange);
      await deps.auth.load();
      onAuthChange();
    },
    async dispose() {
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
      failureListeners.clear();
      accountListeners.clear();
      await refreshing?.catch(() => false);
      await deps.auth.dispose();
    },
  };
}
