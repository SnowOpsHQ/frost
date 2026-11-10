import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  DATA_SET_KEY_RESULTS,
  DATA_SET_SERP_PROVIDER_RESULTS,
  DataSerpProviderViewSchema,
  DataSourcesClearKeyInputSchema,
  DataSourcesSetKeyInputSchema,
  DataSourcesSetSerpProviderInputSchema,
  DataSourcesViewSchema,
  DataUsageViewSchema,
  type DataSetKeyResult,
  type DataSetSerpProviderResult,
} from '@app/specs/data-sources.schema';
import type { DataSourcesService } from './data-sources-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Settings › Data sources ↔ main (Phase 12 Task 1; spec `data-sources.schema.ts`; acceptance
// `data-sources.feature.md`, Keys). Every procedure starts `publicProcedure.use(enforceSender)`, so
// only the app's own window can touch a key. `setKey`'s input is the only place a data key crosses
// IPC (renderer → main); no answer carries one: the view is checked against a strict schema and each
// result against its fixed set before it leaves.

/** Hands the procedure main's `DataSourcesService` (after `enforceSender`; fails closed without it). */
const requireDataSources = middleware(({ ctx, next }) => {
  const dataSources = ctx.services?.dataSources;
  if (!dataSources) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'data sources service unavailable' });
  return next({ ctx: { ...ctx, dataSources } });
});

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => ((values as readonly unknown[]).includes(value) ? (value as T) : fallback);

/**
 * - `status`: `DataSourcesView` (protection; per provider `hasKey` and `available`; never a key).
 * - `setKey` (`DataSourcesSetKeyInput`): `DATA_SET_KEY_RESULTS` (`unavailable` while the provider's legal gate is closed).
 * - `clearKey` (`{ provider }`): whether every slot was cleared (never gated).
 * - `usage` (Task 2): `DataUsageView` (this month's and last month's request counts per provider).
 * - `serpProvider` (Task 2): `DataSerpProviderView` (the "Check via API" vendor and the vendors offered).
 * - `setSerpProvider` (`{ provider }`, Task 2): `DATA_SET_SERP_PROVIDER_RESULTS` (`unavailable` while its gate is closed).
 */
export const dataSourcesRouter = router({
  status: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .output(DataSourcesViewSchema)
    .query(({ ctx }) => ctx.dataSources.status()),
  setKey: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .input(DataSourcesSetKeyInputSchema)
    .mutation(async ({ ctx, input }): Promise<DataSetKeyResult> => oneOf(DATA_SET_KEY_RESULTS, await ctx.dataSources.setKey(input), 'failed')),
  clearKey: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .input(DataSourcesClearKeyInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.dataSources.clearKey(input.provider)) === true),
  usage: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .output(DataUsageViewSchema)
    .query(({ ctx }) => ctx.dataSources.usage()),
  serpProvider: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .output(DataSerpProviderViewSchema)
    .query(({ ctx }) => ctx.dataSources.serpProvider()),
  setSerpProvider: publicProcedure
    .use(enforceSender)
    .use(requireDataSources)
    .input(DataSourcesSetSerpProviderInputSchema)
    .mutation(async ({ ctx, input }): Promise<DataSetSerpProviderResult> => oneOf(DATA_SET_SERP_PROVIDER_RESULTS, await ctx.dataSources.setSerpProvider(input.provider), 'failed')),
});
