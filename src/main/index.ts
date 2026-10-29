import { app, dialog, session } from 'electron';
import type { ProgressEvent } from '../shared/contracts';
import path from 'node:path';
import { broadcast, openProjects, registerIpc } from './ipc';
import { registerAppProtocol, registerPreviewProtocol, registerSchemes } from './preview-protocol';
import { devServerUrl, isAppUrl, startWindow } from './window';
import { WorkerHost } from './worker-host';
import { AiSettings } from './ai-settings';

// userData override exists only for development and automated tests.
const userDataOverride = process.env.EVENTSTORY_USER_DATA;
if (userDataOverride && (!app.isPackaged || process.env.EVENTSTORY_TEST === '1')) {
  app.setPath('userData', path.resolve(userDataOverride));
}

registerSchemes();

const activeExports = new Set<string>();
const onWorkerEvent = (e: ProgressEvent): void => {
  if (e.kind === 'export') {
    if (e.phase === 'complete' || e.phase === 'cancelled') activeExports.delete(e.jobId);
    else activeExports.add(e.jobId);
  }
  broadcast(e);
};

const aiSettings = new AiSettings();
const pushAiCredentials = async (): Promise<void> => {
  await aiSettings.load();
  const c = aiSettings.credentials();
  if (c) await worker.call('setAiCredentials', [c.endpoint, c.token]);
};

const worker = new WorkerHost(onWorkerEvent, async () => {
  await pushAiCredentials();
  // A restarted worker has no open projects; reopen the ones the UI knows about.
  for (const dir of openProjects.values()) await worker.call('openProject', [dir]);
});

function isAllowedRequestUrl(url: string): boolean {
  if (url.startsWith('app://') || url.startsWith('es-preview://')) return true;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('devtools://')) return true;
  const dev = devServerUrl();
  if (dev) {
    const origin = new URL(dev).origin;
    if (url.startsWith(origin) || url.startsWith(origin.replace(/^http/, 'ws'))) return true;
  }
  return false;
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (activeExports.size > 0 && process.env.EVENTSTORY_TEST !== '1') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Tiếp tục xuất', 'Hủy xuất và thoát'],
      defaultId: 0,
      cancelId: 0,
      message: 'Đang xuất ảnh.',
      detail: 'Thoát bây giờ sẽ hủy lần xuất này: các tệp đã kiểm tra được giữ, tệp tạm bị xóa và manifest ghi trạng thái "cancelled".',
    });
    if (choice === 0) return;
  }
  quitting = true;
  void worker.shutdown().finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(() => {
  // No network: everything the renderer needs is packaged or local.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  registerAppProtocol(path.join(__dirname, '../renderer'));
  registerPreviewProtocol(
    (projectId) => {
      const dir = openProjects.get(projectId);
      return dir ? path.join(dir, 'cache', 'previews') : null;
    },
    async (projectId, cacheFile) => (await worker.call<boolean>('restorePreview', [projectId, cacheFile], 60_000)).ok,
  );
  worker.start();
  void pushAiCredentials();
  registerIpc(worker, aiSettings);
  startWindow();
});
