import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { changeRetentionDialog, CHAT_EXPORT_EXTENSIONS, CHAT_EXPORT_FILTER_NAMES, DELETE_ALL_CHATS, type ChatExportFormat, type ChatRetention } from '@app/specs/agent-data.spec';
import { mcpStartDialog } from '@app/specs/agent-mcp.spec';
import type { McpStartPrompt } from './mcp';
import type { AgentDialogs } from './service';

// main's own dialogs for the agent's data (Phase 5 Task 9; acceptance `specs/agent-data.feature.md`):
// "Delete all chats" and a retention change that would delete saved chats ask in a native message box (only `DELETE_ALL_CHATS.confirmIndex` confirms;
// Cancel is the default), and an export is written only where the user chose in a native save
// dialog. Both are parented to the focused window (else any open one; with none, app-modal). The
// renderer never names a path: it asks main to export, and main asks the user.

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
    // Offered in the Downloads folder (the user may go anywhere from there).
    let defaultPath = defaultName;
    try {
      defaultPath = path.join(app.getPath('downloads'), defaultName);
    } catch {
      defaultPath = defaultName;
    }
    const options = { title: 'Export chat', defaultPath, filters: [{ name: CHAT_EXPORT_FILTER_NAMES[format], extensions: [CHAT_EXPORT_EXTENSIONS[format]] }], properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const] };
    const parent = parentWindow();
    const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return canceled || typeof filePath !== 'string' || filePath === '' ? null : filePath;
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
