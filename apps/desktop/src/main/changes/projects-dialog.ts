import { dialog, type BaseWindow } from 'electron';
import { DELETE_PROJECT, deleteProjectDialog } from '@app/specs/projects.spec';

// "Delete project" asks first (spec `projects.spec.ts`, `DELETE_PROJECT`; acceptance
// `projects.feature.md`, Deleting a project): a native message box main shows, parented to `parent`
// (with none, an app-modal box), naming the project (quoted, bidi-isolated). Only
// `DELETE_PROJECT.confirmIndex` confirms; Cancel is the default.

export async function confirmDeleteProject(parent: BaseWindow | null, name: string): Promise<boolean> {
  const options = deleteProjectDialog(name);
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === DELETE_PROJECT.confirmIndex;
}
