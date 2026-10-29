import { app, BrowserWindow, session } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL_SHA256, type LocalAnalysisSettings, type LocalInference } from '../shared/local-analysis';

/** A dedicated sandboxed Chromium process. No Node, preload, network or app API. */
export class LocalAnalysisHost {
  private win: BrowserWindow | null = null;
  private loading: Promise<BrowserWindow> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly modelFile = () => path.join(app.getPath('userData'), 'local-models', 'face_landmarker.task');
  private verify(model: Buffer): void {
    if (model.length !== 3_758_596 || createHash('sha256').update(model).digest('hex') !== LOCAL_MODEL_SHA256)
      throw new Error('Model không đúng bản Face Landmarker đã kiểm tra (SHA-256 không khớp).');
  }
  async settings(): Promise<LocalAnalysisSettings> {
    try { this.verify(await readFile(this.modelFile())); return { available: true, modelName: 'Face Landmarker v1 (prototype)' }; }
    catch { return { available: false, modelName: null }; }
  }
  async install(file: string): Promise<LocalAnalysisSettings> {
    if (this.loading) throw new Error('Đang khởi tạo model, hãy chờ rồi thử lại.');
    if ((await stat(file)).size !== 3_758_596) throw new Error('Kích thước model không đúng bản đã kiểm tra.');
    const model = await readFile(file);
    this.verify(model);
    await mkdir(path.dirname(this.modelFile()), { recursive: true });
    await writeFile(this.modelFile(), model);
    this.dispose();
    // A successful selection means the runtime really initialized, not just a file check.
    await this.ready();
    return this.settings();
  }
  private async ready(): Promise<BrowserWindow> {
    if (this.loading) return this.loading;
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.loading = this.create();
    try { return await this.loading; }
    catch (e) { this.dispose(); throw e; }
    finally { this.loading = null; }
  }
  private async create(): Promise<BrowserWindow> {
    const model = await readFile(this.modelFile()).catch(() => { throw new Error('Chưa chọn model local. Chọn face_landmarker.task trước.'); });
    this.verify(model);
    const root = path.resolve(__dirname, '../renderer');
    const isolated = session.fromPartition('eventstory-local-inference');
    isolated.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
      let allowed = details.url.startsWith('blob:');
      if (details.url.startsWith('file:')) {
        try {
          const rel = path.relative(root, fileURLToPath(details.url));
          allowed = !rel.startsWith('..') && !path.isAbsolute(rel);
        } catch { /* blocked */ }
      }
      cb({ cancel: !allowed });
    });
    const win = new BrowserWindow({ show: false, webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, webgl: true,
    } });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('will-redirect', (e) => e.preventDefault());
    win.on('closed', () => { if (this.win === win) this.win = null; });
    await win.loadFile(path.join(root, 'local-analysis.html'));
    const require = createRequire(__filename);
    const loader = await readFile(require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.js'));
    const wasm = await readFile(require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm'));
    await this.limit(win, win.webContents.executeJavaScript(`window.localRunner.initialize(${[model, loader, wasm].map((b) => JSON.stringify(b.toString('base64'))).join(',')})`));
    return win;
  }
  private async limit<T>(win: BrowserWindow, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); reject(new Error('LOCAL_TIMEOUT: Phân tích local quá thời gian chờ.')); }, 90_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  detect(jpeg: Uint8Array): Promise<LocalInference> {
    // All projects share one model, and never run simultaneous WASM calls.
    const work = this.tail.catch(() => {}).then(async () => {
      if (jpeg.byteLength > 5_000_000) throw new Error('Ảnh phân tích local quá lớn.');
      const win = await this.ready();
      return this.limit<LocalInference>(win, win.webContents.executeJavaScript(`window.localRunner.detect(${JSON.stringify(Buffer.from(jpeg).toString('base64'))})`));
    });
    this.tail = work;
    return work;
  }
  dispose(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
