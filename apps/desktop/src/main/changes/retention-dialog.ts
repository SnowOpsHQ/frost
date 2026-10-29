import { dialog, type BaseWindow, type MessageBoxOptions } from 'electron';
import { COMPACT_DATABASE, PURGE_NOW, compactDialog, purgeNowDialog, type PurgeCountsView, type RetentionPolicyInput } from '@app/specs/retention.spec';

// "Purge now" and "Compact the change database" ask first (spec `retention.spec.ts`, `PURGE_NOW`,
// `COMPACT_DATABASE`; acceptance `retention.feature.md`): native message boxes main shows, parented
// to `parent` (with none, an app-modal box). The purge's box shows the plan it will execute: its
// counts and bytes, the saved policy it follows, and the project's name (quoted, bidi-isolated). Only the confirm index confirms;
// Cancel is the default.

const ask = async (parent: BaseWindow | null, options: MessageBoxOptions): Promise<number> => (parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)).response;

export async function confirmPurgeNow(parent: BaseWindow | null, name: string, policy: RetentionPolicyInput, counts: PurgeCountsView, bytes: number): Promise<boolean> {
  return (await ask(parent, purgeNowDialog(name, policy, counts, bytes))) === PURGE_NOW.confirmIndex;
}

export async function confirmCompact(parent: BaseWindow | null): Promise<boolean> {
  return (await ask(parent, compactDialog())) === COMPACT_DATABASE.confirmIndex;
}
