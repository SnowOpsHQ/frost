import { app, BrowserWindow } from 'electron';
import { createMainWindow, loadRenderer } from './window';

// Global backstop: every renderer is sandboxed even if a future WebContents forgets the explicit pref.
app.enableSandbox();

function openMainWindow(): void {
  loadRenderer(createMainWindow()).catch((err: unknown) => {
    console.error('failed to load renderer', err);
    app.quit();
  });
}

void app.whenReady().then(() => {
  openMainWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
