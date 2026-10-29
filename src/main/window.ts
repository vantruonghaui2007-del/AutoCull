import { app, BrowserWindow } from 'electron';
import path from 'node:path';

export const APP_ORIGIN = 'app://bundle';
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/** Dev server URL from electron-vite, only honoured when running unpackaged. */
export function devServerUrl(): string | null {
  const url = process.env.ELECTRON_RENDERER_URL;
  return !app.isPackaged && url ? url : null;
}

export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'app:' && u.host === 'bundle') return true;
    const dev = devServerUrl();
    return dev !== null && u.origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

const appWindowIds = new Set<number>();

export function isAppWebContents(id: number): boolean {
  return appWindowIds.has(id);
}

export function startWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'EventStory Cull',
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#15171a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  const id = win.webContents.id;
  appWindowIds.add(id);
  win.on('closed', () => {
    appWindowIds.delete(id);
    // The hidden local inference window must not keep the application alive.
    if (appWindowIds.size === 0) app.quit();
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(devServerUrl() ?? APP_INDEX_URL);
  return win;
}
