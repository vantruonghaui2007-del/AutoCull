import { utilityProcess, type UtilityProcess } from 'electron';
import os from 'node:os';
import path from 'node:path';
import type { ProgressEvent, Result } from '../shared/contracts';
import type { WorkerMessage, WorkerRequest } from '../shared/rpc';
import { restartDelay } from './restart-policy';
import { LocalAnalysisHost } from './local-analysis-host';

type Pending = { resolve: (r: Result<unknown>) => void; timer: NodeJS.Timeout | null };

/** Owns the worker utility process: request/response RPC, progress events, restart, clean shutdown. */
export class WorkerHost {
  readonly localAnalysis = new LocalAnalysisHost();
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyWaiters: (() => void)[] = [];
  private ready = false;
  private stopping = false;
  private crashes: number[] = [];
  state: 'starting' | 'ready' | 'restarting' | 'failed' = 'starting';

  constructor(
    private readonly onEvent: (e: ProgressEvent) => void,
    private readonly onRestart: () => Promise<void>,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const entry = path.join(__dirname, 'worker.js');
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'eventstory-worker',
      stdio: 'pipe',
      env: {
        ...process.env,
        EVENTSTORY_TOTAL_MEM: String(os.totalmem()),
        EVENTSTORY_RESOURCES: process.resourcesPath ?? '',
      },
    });
    this.child = child;
    this.ready = false;
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[worker] ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[worker] ${d}`));
    child.on('message', (msg: WorkerMessage) => {
      if ('localDetect' in msg) {
        void this.localAnalysis.detect(msg.jpeg).then(
          (value) => { if (this.child === child) child.postMessage({ localResult: msg.localDetect, result: { ok: true, value } }); },
          (e: unknown) => { if (this.child === child) child.postMessage({ localResult: msg.localDetect, result: { ok: false, code: 'LOCAL_INFERENCE_FAILED', message: (e as Error).message } }); },
        );
      } else this.handleMessage(msg);
    });
    child.on('exit', (code) => this.handleExit(child, code));
  }

  private handleMessage(msg: Exclude<WorkerMessage, { localDetect: number }>): void {
    if ('ready' in msg) {
      const wasRestart = this.state === 'restarting';
      this.ready = true;
      this.state = 'ready';
      this.readyWaiters.splice(0).forEach((w) => w());
      if (wasRestart) {
        void this.onRestart().then(() => this.onEvent({ kind: 'worker-restarted' }));
      }
      return;
    }
    if ('event' in msg) {
      this.onEvent(msg.event);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(msg.result);
  }

  private handleExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    this.localAnalysis.dispose();
    this.ready = false;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ ok: false, code: 'WORKER_RESTARTED', message: 'Tiến trình xử lý đã khởi động lại; hãy tải lại trạng thái.' });
      this.pending.delete(id);
    }
    if (this.stopping) return;
    this.crashes.push(Date.now());
    const delay = restartDelay(this.crashes, Date.now());
    if (delay === null) {
      process.stderr.write(`[main] worker keeps crashing (last code ${code}); giving up\n`);
      this.state = 'failed';
      this.readyWaiters.splice(0).forEach((w) => w());
      return;
    }
    process.stderr.write(`[main] worker exited with code ${code}; restarting in ${delay} ms\n`);
    this.state = 'restarting';
    setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
  }

  private waitReady(): Promise<void> {
    if (this.ready || this.state === 'failed') return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  async call<T>(method: string, params: unknown[] = [], timeoutMs = 0): Promise<Result<T>> {
    if (this.stopping) return { ok: false, code: 'SHUTTING_DOWN', message: 'Ứng dụng đang đóng.' };
    await this.waitReady();
    if (this.state === 'failed') {
      return {
        ok: false,
        code: 'WORKER_FAILED',
        message: 'Bộ xử lý ảnh không khởi động được. Bản cài có thể thiếu thành phần (ExifTool/Sharp) — hãy cài lại ứng dụng.',
      };
    }
    const child = this.child;
    if (!child) return { ok: false, code: 'WORKER_UNAVAILABLE', message: 'Tiến trình xử lý chưa sẵn sàng.' };
    const id = this.nextId++;
    return new Promise<Result<T>>((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              resolve({ ok: false, code: 'TIMEOUT', message: `Hết thời gian chờ: ${method}` });
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (r: Result<unknown>) => void, timer });
      const req: WorkerRequest = { id, method, params };
      child.postMessage(req);
    });
  }

  async shutdown(graceMs = 8000): Promise<void> {
    this.localAnalysis.dispose();
    if (!this.child) return;
    const child = this.child;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const shutdownCall = this.call('shutdown', [], graceMs);
    this.stopping = true;
    await Promise.race([Promise.all([shutdownCall, exited]), new Promise((r) => setTimeout(r, graceMs))]);
    if (this.child === child) {
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    this.child = null;
  }
}
