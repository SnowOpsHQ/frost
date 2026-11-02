import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import {
  changeRetentionDialog,
  CHAT_EXPORT_EXTENSIONS,
  CHAT_EXPORT_FILTER_NAMES,
  DELETE_ALL_CHATS,
  SKILL_FILE_EXTENSION,
  SKILL_FILE_FILTER_NAME,
  type ChatExportFormat,
  type ChatRetention,
} from '@app/specs/agent-data.spec';
import { mcpStartDialog } from '@app/specs/agent-mcp.spec';
import type { McpStartPrompt } from './mcp';
import type { AgentDialogs } from './service';

// main's own dialogs for the agent's data (Phase 5 Task 9; acceptance `specs/agent-data.feature.md`):
// "Delete all chats" and a retention change that would delete saved chats ask in a native message box (only `DELETE_ALL_CHATS.confirmIndex` confirms;
// Cancel is the default), and an export is written only where the user chose in a native save
// dialog. Both are parented to the focused window (else any open one; with none, app-modal). The
// renderer never names a path: it asks main to export, and main asks the user. Skills files (Phase 8
// Task 6) likewise: saved where the user chose, and imported only from the file the user picked in
// main's open dialog (one file, JSON filter).

/** Offered in the Downloads folder (the user may go anywhere from there). */
function inDownloads(name: string): string {
  try {
    return path.join(app.getPath('downloads'), name);
  } catch {
    return name;
  }
}

const SKILL_FILE_FILTERS = [{ name: SKILL_FILE_FILTER_NAME, extensions: [SKILL_FILE_EXTENSION] }];

const parentWindow = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;

export const electronAgentDialogs: AgentDialogs = {
  async confirmDeleteAllChats() {
    const options = { ...DELETE_ALL_CHATS.dialog, buttons: [...DELETE_ALL_CHATS.dialog.buttons] };
    const parent = parentWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === DELETE_ALL_CHATS.confirmIndex;
  },
  async confirmRetentionChange(retention: ChatRetention, chats: number) {
    const { dialog: box, confirmIndex } = changeRetentionDialog(retention, chats);
    const options = { ...box, buttons: [...box.buttons] };
    const parent = parentWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === confirmIndex;
  },
  async chooseExportPath(defaultName: string, format: ChatExportFormat) {
    const options = { title: 'Export chat', defaultPath: inDownloads(defaultName), filters: [{ name: CHAT_EXPORT_FILTER_NAMES[format], extensions: [CHAT_EXPORT_EXTENSIONS[format]] }], properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const] };
    const parent = parentWindow();
    const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return canceled || typeof filePath !== 'string' || filePath === '' ? null : filePath;
  },
  async chooseSkillExportPath(defaultName: string) {
    const options = { title: 'Export skills', defaultPath: inDownloads(defaultName), filters: SKILL_FILE_FILTERS, properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const] };
    const parent = parentWindow();
    const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return canceled || typeof filePath !== 'string' || filePath === '' ? null : filePath;
  },
  async chooseSkillImportFile() {
    const options = { title: 'Import skills', defaultPath: inDownloads(''), filters: SKILL_FILE_FILTERS, properties: ['openFile' as const] };
    const parent = parentWindow();
    const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const file = Array.isArray(filePaths) && filePaths.length === 1 ? filePaths[0] : undefined;
    return canceled || typeof file !== 'string' || file === '' ? null : file;
  },
  async confirmMcpStart(prompt: McpStartPrompt) {
    // Task 10: the exact command line, the sandbox in effect, "untrusted"; Cancel is the default.
    const { dialog: box, confirmIndex } = mcpStartDialog(prompt);
    const options = { ...box, buttons: [...box.buttons] };
    const parent = parentWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === confirmIndex;
  },
};
