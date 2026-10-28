import { TRPCError } from '@trpc/server';
import {
  EntitlementsSchema,
  entitlementGrants,
  FEATURE_FLAGS,
  FEATURE_NOT_ENTITLED_CODE,
  type FeatureFlag,
} from '@app/specs/entitlements-snapshot.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The account ↔ main (Phase 4; spec `entitlements-snapshot.spec.ts`; acceptance
// `entitlements-client.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.
// Task 4 ships `account.entitlements` and the `requireFeature` gate; Task 5 adds the sign-in flow.

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

/**
 * `entitlements` answers main's verified `Entitlements` (strictly `EntitlementsSchema`: a service
 * answer with any other member, such as a snapshot, is refused as a masked internal error rather
 * than forwarded).
 */
export const accountRouter = router({
  entitlements: publicProcedure
    .use(enforceSender)
    .use(requireAccount)
    .output(EntitlementsSchema)
    .query(({ ctx }) => ctx.account.entitlements()),
});
