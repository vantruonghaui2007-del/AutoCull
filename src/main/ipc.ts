import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProgressEvent, ProjectSnapshot, Result } from '../shared/contracts';
import { PROGRESS_CHANNEL } from '../shared/rpc';
import {
  AiEndpointSchema,
  AiTokenInputSchema,
  AssetIdListSchema,
  AssetQuerySchema,
  err,
  ExportModeSchema,
  JobIdSchema,
  ok,
  ExportSetSchema,
  PackIdSchema,
  parseProjectCommand,
  PlanIdSchema,
  ProjectIdSchema,
  ProjectNameSchema,
  SourceIdSchema,
  validate,
} from '../shared/schemas';
import { isAppUrl, isAppWebContents } from './window';
import type { WorkerHost } from './worker-host';
import type { AiSettings } from './ai-settings';

/** Only the main frame of an app window showing app content may call the API. */
export function isAllowedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (frame !== event.sender.mainFrame) return false;
  if (!isAppWebContents(event.sender.id)) return false;
  return isAppUrl(frame.url);
}

const FORBIDDEN: Result<never> = { ok: false, code: 'FORBIDDEN', message: 'Nguồn gọi không được phép.' };

/** Project directories opened in this session; the preview protocol and worker restarts use them. */
export const openProjects = new Map<string, string>();

function sanitizeFolderName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned.length ? cleaned.slice(0, 80) : 'EventStory project';
}

export function broadcast(event: ProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (isAppWebContents(win.webContents.id)) win.webContents.send(PROGRESS_CHANNEL, event);
  }
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

async function pickDirectory(event: IpcMainInvokeEvent, title: string, multi = false): Promise<string[] | null> {
  const win = windowOf(event);
  const options: Electron.OpenDialogOptions = {
    title,
    properties: multi ? ['openDirectory', 'multiSelections', 'createDirectory'] : ['openDirectory', 'createDirectory'],
  };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths;
}

export function registerIpc(worker: WorkerHost, ai: AiSettings): void {
  const handle = (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Result<unknown>>) => {
    ipcMain.handle(`es:${name}`, async (event, ...args) => {
      if (!isAllowedSender(event)) return FORBIDDEN;
      try {
        return await fn(event, ...args);
      } catch (e) {
        return err('INTERNAL', (e as Error).message);
      }
    });
  };

  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  const readSettings = async (): Promise<{ lastProjectDir?: string }> => {
    try {
      return JSON.parse(await readFile(settingsFile(), 'utf8')) as { lastProjectDir?: string };
    } catch {
      return {};
    }
  };
  const rememberProject = (r: Result<unknown>, dir: string): void => {
    if (!r.ok || !r.value) return;
    openProjects.set((r.value as ProjectSnapshot).id, dir);
    void readSettings().then((s) => writeFile(settingsFile(), JSON.stringify({ ...s, lastProjectDir: dir }, null, 2)).catch(() => {}));
  };

  handle('restoreLastProject', async () => {
    const { lastProjectDir } = await readSettings();
    if (!lastProjectDir) return ok(null);
    const r = await worker.call('openProject', [lastProjectDir]);
    if (!r.ok && (r.code === 'NOT_A_PROJECT' || r.code === 'OPEN_FAILED')) return ok(null);
    if (r.ok) openProjects.set((r.value as ProjectSnapshot).id, lastProjectDir);
    return r;
  });

  handle('getAppStatus', async () => {
    const st = await worker.call<{ exiftoolVersion: string | null; resources: { metadataJobs: number; imageJobs: number } }>('status');
    if (!st.ok) return st;
    return ok({
      worker: worker.state,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      exiftoolVersion: st.value.exiftoolVersion,
      resources: st.value.resources,
    });
  });

  handle('createProject', async (event, name) => {
    const n = validate(ProjectNameSchema, name);
    if (!n.ok) return n;
    const picked = await pickDirectory(event, 'Chọn thư mục để lưu dự án');
    if (!picked) return ok(null);
    const dir = path.join(picked[0]!, sanitizeFolderName(n.value));
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length > 0) {
      return err('PROJECT_DIR_NOT_EMPTY', `Thư mục "${path.basename(dir)}" đã có dữ liệu. Hãy chọn nơi khác hoặc dùng “Mở dự án”.`);
    }
    const r = await worker.call('createProject', [dir, n.value]);
    rememberProject(r, dir);
    return r;
  });

  handle('openProject', async (event) => {
    const picked = await pickDirectory(event, 'Mở thư mục dự án EventStory');
    if (!picked) return ok(null);
    const r = await worker.call('openProject', [picked[0]]);
    rememberProject(r, picked[0]!);
    return r;
  });

  handle('closeProject', async (_e, projectId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const r = await worker.call('closeProject', [p.value]);
    openProjects.delete(p.value);
    return r;
  });

  const projectCall = (name: string, method = name) =>
    handle(name, async (_e, projectId) => {
      const p = validate(ProjectIdSchema, projectId);
      if (!p.ok) return p;
      return worker.call(method, [p.value]);
    });
  projectCall('getProjectState');
  projectCall('listGroups');
  projectCall('listPairCandidates');
  projectCall('listDeliveries');

  handle('chooseSources', async (event, projectId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const picked = await pickDirectory(event, 'Chọn thư mục ảnh nguồn (thẻ nhớ / SSD)', true);
    if (!picked) return ok(null);
    return worker.call('addSources', [p.value, picked]);
  });

  handle('relinkSource', async (event, projectId, sourceId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const s = validate(SourceIdSchema, sourceId);
    if (!s.ok) return s;
    const picked = await pickDirectory(event, 'Chọn vị trí mới của thư mục nguồn');
    if (!picked) return ok(null);
    return worker.call('relinkSource', [p.value, s.value, picked[0]]);
  });

  handle('cancelJob', async (_e, jobId) => {
    const j = validate(JobIdSchema, jobId);
    if (!j.ok) return j;
    return worker.call('cancelJob', [j.value]);
  });

  handle('queryAssets', async (_e, projectId, query) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const q = validate(AssetQuerySchema, query);
    if (!q.ok) return q;
    return worker.call('queryAssets', [p.value, q.value]);
  });

  handle('applyCommand', async (_e, projectId, command) => {
    const c = parseProjectCommand(command);
    if (!c.ok) return c;
    const p = validate(ProjectIdSchema, projectId, 'INVALID_COMMAND');
    if (!p.ok) return p;
    return worker.call('applyCommand', [p.value, c.value]);
  });

  handle('suggestPack', async (_e, projectId, packId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const k = validate(PackIdSchema, packId);
    if (!k.ok) return k;
    return worker.call('suggestPack', [p.value, k.value]);
  });

  handle('previewExport', async (event, projectId, packId, mode) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const k = validate(ExportSetSchema, packId);
    if (!k.ok) return k;
    const m = validate(ExportModeSchema, mode);
    if (!m.ok) return m;
    const picked = await pickDirectory(event, 'Chọn nơi tạo thư mục xuất (ngoài thư mục nguồn và dự án)');
    if (!picked) return ok(null);
    return worker.call('planExport', [p.value, k.value, picked[0], m.value]);
  });

  handle('confirmExport', async (_e, planId) => {
    const x = validate(PlanIdSchema, planId);
    if (!x.ok) return x;
    return worker.call('executeExport', [x.value]);
  });

  handle('getExportReport', async (_e, jobId) => {
    const j = validate(JobIdSchema, jobId);
    if (!j.ok) return j;
    return worker.call('getExportReport', [j.value]);
  });

  handle('openExportFolder', async (_e, jobId) => {
    const j = validate(JobIdSchema, jobId);
    if (!j.ok) return j;
    const folder = await worker.call<string>('exportFolderPath', [j.value]);
    if (!folder.ok) return folder;
    const msg = await shell.openPath(folder.value);
    return msg ? err('OPEN_FAILED', msg) : ok(undefined);
  });

  handle('exportPortable', async (event, projectId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const win = windowOf(event);
    const opts: Electron.SaveDialogOptions = {
      title: 'Lưu tệp phiên (không chứa ảnh RAW)',
      defaultPath: 'phien-loc.eventstory.json',
      filters: [{ name: 'EventStory session', extensions: ['json'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return ok(null);
    const r = await worker.call('exportPortable', [p.value, res.filePath]);
    return r.ok ? ok(path.basename(res.filePath)) : r;
  });

  handle('getAiSettings', async () => {
    await ai.load();
    return ok(ai.view());
  });

  handle('saveAiSettings', async (_e, endpoint, token) => {
    const ep = validate(AiEndpointSchema, endpoint);
    if (!ep.ok) return ep;
    const tk = validate(AiTokenInputSchema, token);
    if (!tk.ok) return tk;
    await ai.load();
    // Validate in the worker before persisting; a failed first save must leave disk untouched.
    const previous = ai.credentials();
    const nextToken = tk.value === null ? previous?.token ?? null : tk.value;
    const pushed = await worker.call('setAiCredentials', [ep.value, nextToken]);
    if (!pushed.ok) return pushed;
    try {
      await ai.save(ep.value, tk.value);
    } catch (e) {
      await worker.call('setAiCredentials', [previous?.endpoint ?? null, previous?.token ?? null]);
      throw e;
    }
    return ok(ai.view());
  });

  handle('setAiConsent', async (_e, accepted) => {
    if (typeof accepted !== 'boolean') return err('INVALID_ARGUMENT', 'Giá trị không hợp lệ.');
    await ai.setConsent(accepted);
    if (!accepted) await worker.call('cancelAnalysisJobs');
    return ok(ai.view());
  });

  handle('getAiQuota', async () => worker.call('aiQuota'));
  handle('getLocalAnalysisSettings', async () => ok(await worker.localAnalysis.settings()));
  handle('selectLocalModel', async (event) => {
    const opts: Electron.OpenDialogOptions = { title: 'Chọn face_landmarker.task (prototype local)', properties: ['openFile'], filters: [{ name: 'MediaPipe model', extensions: ['task'] }] };
    const win = windowOf(event);
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return ok(await worker.localAnalysis.settings());
    return ok(await worker.localAnalysis.install(picked.filePaths[0]));
  });

  handle('startAutoCull', async (_e, projectId, engine = 'cloud') => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    if (engine !== 'cloud' && engine !== 'local') return err('INVALID_ARGUMENT', 'Engine không hợp lệ.');
    if (engine === 'local') {
      if (!(await worker.localAnalysis.settings()).available) return err('LOCAL_MODEL_REQUIRED', 'Chọn model local trước khi chạy.');
      return worker.call('startAutoCull', [p.value, null, 'local']);
    }
    await ai.load();
    // Without consent nothing is sent: the run still groups and ranks, and reports why analysis was skipped.
    const blocked = ai.credentials() && !ai.view().consentAt ? 'Chưa đồng ý gửi ảnh xem trước tới AWS (mục Phân tích AI)' : null;
    return worker.call('startAutoCull', [p.value, blocked]);
  });

  handle('getCullState', async (_e, projectId) => {
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    return worker.call('getCullState', [p.value]);
  });

  handle('analyzeFaces', async (_e, projectId, assetIds, retryFailed) => {
    if (retryFailed !== undefined && typeof retryFailed !== 'boolean') return err('INVALID_ARGUMENT', 'Giá trị không hợp lệ.');
    const p = validate(ProjectIdSchema, projectId);
    if (!p.ok) return p;
    const ids = validate(AssetIdListSchema, assetIds);
    if (!ids.ok) return ids;
    await ai.load();
    if (!ai.view().consentAt) return err('AI_CONSENT_REQUIRED', 'Hãy đọc và đồng ý thông báo gửi ảnh xem trước tới AWS trong phần cài đặt Phân tích AI.');
    return worker.call('analyzeFaces', [p.value, ids.value, retryFailed === true]);
  });

  handle('importPortable', async (event) => {
    const win = windowOf(event);
    const opts: Electron.OpenDialogOptions = {
      title: 'Chọn tệp phiên EventStory',
      properties: ['openFile'],
      filters: [{ name: 'EventStory session', extensions: ['json'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return ok(null);
    const dirPick = await pickDirectory(event, 'Chọn thư mục trống để tạo dự án từ tệp phiên');
    if (!dirPick) return ok(null);
    const r = await worker.call('importPortable', [res.filePaths[0], dirPick[0]]);
    rememberProject(r, dirPick[0]!);
    return r;
  });
}
