// Spec: specs/devtools.spec.ts (NETWORK_EXPORT_DIALOG)
// Acceptance: specs/devtools.feature.md (Network export: main's dialog in the window that asked; the file is written
// with mode 0600, also over an existing file; whole-branch review)
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const windows = new Map<number, { id: number; destroyed: boolean; isDestroyed(): boolean }>();
  const win = (id: number, destroyed = false) => {
    const w = { id, destroyed, isDestroyed: () => w.destroyed };
    windows.set(id, w);
    return w;
  };
  return {
    windows,
    win,
    showSaveDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePath: '/downloads/net.har' })),
    focused: null as unknown,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: {
    fromId: (id: number) => electron.windows.get(id) ?? null,
    getFocusedWindow: () => electron.focused,
    getAllWindows: () => [...electron.windows.values()],
  },
  dialog: { showSaveDialog: electron.showSaveDialog },
  session: { fromPartition: () => ({}) },
}));

const { chooseNetworkExportPath, networkExportIo } = await import('../site-data');

afterEach(() => {
  electron.windows.clear();
  electron.showSaveDialog.mockClear();
  electron.focused = null;
});

describe('network export dialog and file', () => {
  test('network-export-dialog-parented-to-the-sender-window', async () => {
    const sender = electron.win(3);
    // Another window has focus: the dialog still goes to the one that asked.
    electron.focused = electron.win(5);
    await expect(chooseNetworkExportPath('net.har', 'har', 3)).resolves.toBe('/downloads/net.har');
    expect(electron.showSaveDialog).toHaveBeenLastCalledWith(sender, expect.objectContaining({ defaultPath: path.join('/downloads', 'net.har') }));
    // No sender window, an unknown one or a closed one: app-modal (no parent), never another window.
    electron.win(7, true);
    for (const id of [null, 99, 7]) {
      await chooseNetworkExportPath('net.csv', 'csv', id);
      expect(electron.showSaveDialog.mock.lastCall).toHaveLength(1);
    }
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(chooseNetworkExportPath('net.har', 'har', 3)).resolves.toBeNull();
  });

  test('network-export-file-is-private-even-when-overwritten', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frost-network-export-'));
    try {
      const file = path.join(dir, 'net.har');
      await writeFile(file, 'old', { mode: 0o644 });
      await networkExportIo.writeFile(file, '{"log":{}}\n');
      expect(await readFile(file, 'utf8')).toBe('{"log":{}}\n');
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      const fresh = path.join(dir, 'fresh.csv');
      await networkExportIo.writeFile(fresh, 'a,b\r\n');
      if (process.platform !== 'win32') expect((await stat(fresh)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
