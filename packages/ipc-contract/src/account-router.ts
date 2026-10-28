import { TRPCError } from '@trpc/server';
import {
  AccountActionResultSchema,
  AccountRequestInputSchema,
  AccountStateSchema,
  AccountWatchInputSchema,
  SignInResultSchema,
  type AccountState,
} from '@app/specs/account-state.schema';
import { SettingsViewStateSchema, SettingsViewWatchInputSchema, type SettingsViewState } from '@app/specs/account-settings.schema';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import {
  EntitlementsSchema,
  entitlementGrants,
  FEATURE_FLAGS,
  FEATURE_NOT_ENTITLED_CODE,
  type FeatureFlag,
} from '@app/specs/entitlements-snapshot.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { AccountService, SettingsRequests } from './account-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The account ↔ main (Phase 4; specs `entitlements-snapshot.spec.ts`, `account-state.schema.ts`;
// acceptance `entitlements-client.feature.md` and `account-signin.feature.md`, Router). Every procedure
// starts `publicProcedure.use(enforceSender)`. Task 4: `account.entitlements` and the `requireFeature`
// gate; Task 5: the sign-in flow. Every output is validated with a strict schema, so a service answer
// that carries anything else (a token, a snapshot) is a masked internal error, never forwarded.

/** Hands the procedure main's `AccountService` (after `enforceSender`; fails closed without it). */
const requireAccount = middleware(({ ctx, next }) => {
  const account = ctx.services?.account;
  if (!account) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'account service unavailable' });
  return next({ ctx: { ...ctx, account } });
});

const KNOWN_FLAGS: ReadonlySet<string> = new Set(FEATURE_FLAGS);

/**
 * Gates a procedure on feature `flag` (plan "Interfaces for other phases"); chain it after
 * `enforceSender`: `publicProcedure.use(enforceSender).use(requireFeature('ai-agent'))`. Lets the call
 * through only while main's entitlements grant `flag` (`entitlementGrants`: an `active` or `grace`
 * snapshot carrying it), read at call time. Otherwise rejects with `FORBIDDEN`, message and
 * `cause.code` `FEATURE_NOT_ENTITLED_CODE`, before any input is parsed or the handler runs. Without
 * `services.account`, a masked internal error.
 */
export function requireFeature(flag: FeatureFlag) {
  if (!KNOWN_FLAGS.has(flag)) throw new Error('requireFeature: unknown feature flag');
  return middleware(({ ctx, next }) => {
    const account = ctx.services?.account;
    if (!account) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'account service unavailable' });
    if (!entitlementGrants(account.entitlements(), flag)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: FEATURE_NOT_ENTITLED_CODE,
        cause: Object.assign(new Error(FEATURE_NOT_ENTITLED_CODE), { code: FEATURE_NOT_ENTITLED_CODE }),
      });
    }
    return next({ ctx });
  });
}

/** The long-poll behind `account.watch` (as `browser.watch`): the state at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchAccount(account: AccountService, sinceVersion: number): Promise<AccountState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      account.watch(sinceVersion, release.signal),
      new Promise<AccountState>((resolve) => {
        timer = setTimeout(() => resolve(account.state()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * - `entitlements`: main's verified `Entitlements` (strictly `EntitlementsSchema`).
 * - `state` / `watch`: the account (`AccountStateSchema`; `watch` long-polls on `sinceVersion`).
 * - `signIn`: starts a sign-in for the sender's window (`SignInResult`; `needs-gesture` without a live
 *   user gesture there).
 * - `confirmSignIn` / `cancelSignIn` (`{ requestId }`), `signOut`, `refresh`: a boolean (see
 *   `AccountService`; `confirmSignIn` also hands over the sender's window, which must have started the
 *   request and have a live gesture).
 */
/** The long-poll behind `account.settingsWatch` (as `watchAccount`), for the sender's window. */
async function watchSettings(settings: SettingsRequests, windowId: number, sinceSeq: number): Promise<SettingsViewState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settings.watch(windowId, sinceSeq, release.signal),
      new Promise<SettingsViewState>((resolve) => {
        timer = setTimeout(() => resolve(settings.state(windowId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

export const accountRouter = router({
  entitlements: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(EntitlementsSchema)
    .query(({ ctx }) => ctx.account.entitlements()),
  state: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(AccountStateSchema)
    .query(({ ctx }) => ctx.account.state()),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .input(AccountWatchInputSchema)
    .output(AccountStateSchema)
    .query(({ ctx, input }) => watchAccount(ctx.account, input.sinceVersion)),
  signIn: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(SignInResultSchema)
    .mutation(({ ctx }) => {
      // `enforceSender` admitted only a known app window, so there is a window ID.
      const windowId = ctx.sender?.windowId;
      if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
      return ctx.account.signIn(windowId);
    }),
  confirmSignIn: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .input(AccountRequestInputSchema)
    .output(AccountActionResultSchema)
    .mutation(({ ctx, input }) => {
      // The confirmation is bound to the window that started the request (checked by the service).
      const windowId = ctx.sender?.windowId;
      if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
      return ctx.account.confirmSignIn(windowId, input.requestId);
    }),
  cancelSignIn: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .input(AccountRequestInputSchema)
    .output(AccountActionResultSchema)
    .mutation(({ ctx, input }) => ctx.account.cancelSignIn(input.requestId)),
  signOut: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(AccountActionResultSchema)
    .mutation(({ ctx }) => ctx.account.signOut()),
  refresh: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(AccountActionResultSchema)
    .mutation(({ ctx }) => ctx.account.refresh()),
  // The Settings view (Task 9, `account-settings.feature.md`): the menu's requests to open it in the
  // sender's window (a counter, long-polled).
  settingsWatch: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .input(SettingsViewWatchInputSchema)
    .output(SettingsViewStateSchema)
    .query(({ ctx, input }) => {
      const windowId = ctx.sender?.windowId;
      const settings = ctx.account.settings;
      if (typeof windowId !== 'number' || !settings) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'settings requests unavailable' });
      return watchSettings(settings, windowId, input.sinceSeq);
    }),
});
