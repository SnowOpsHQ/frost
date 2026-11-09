import { dialog, type BaseWindow } from 'electron';
import { DELETE_PROJECT, RANK_RUN_DISCLOSURE, deleteProjectDialog } from '@app/specs/projects.spec';

// "Delete project" asks first (spec `projects.spec.ts`, `DELETE_PROJECT`; acceptance
// `projects.feature.md`, Deleting a project): a native message box main shows, parented to `parent`
// (with none, an app-modal box), naming the project (quoted, bidi-isolated). Only
// `DELETE_PROJECT.confirmIndex` confirms; Cancel is the default.
// Runs that query search engines say so first (Phase 10 Task 8, `RANK_RUN_DISCLOSURE`; acceptance
// `projects.feature.md`, Searches in a run): the same kind of box, parented the same way; only
// `RANK_RUN_DISCLOSURE.confirmIndex` (Continue) agrees; Cancel is the default.

export async function confirmDeleteProject(parent: BaseWindow | null, name: string): Promise<boolean> {
  const options = deleteProjectDialog(name);
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === DELETE_PROJECT.confirmIndex;
}

/** Asks `RANK_RUN_DISCLOSURE` (frost's own words, no page text); whether the user chose Continue. */
export async function confirmRankRun(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...RANK_RUN_DISCLOSURE.dialog, buttons: [...RANK_RUN_DISCLOSURE.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === RANK_RUN_DISCLOSURE.confirmIndex;
}
