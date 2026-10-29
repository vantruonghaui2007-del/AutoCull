import type { JobId, Result } from '../shared/contracts';

export type Lane = 'metadata' | 'image';

interface Task {
  jobId: JobId;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (r: Result<unknown>) => void;
  controller: AbortController;
}

/**
 * Bounded work queue with one lane for metadata (ExifTool) and one for image work (Sharp, RAW
 * helper). Each task carries its job ID. On timeout or cancel the task's AbortSignal fires and the
 * caller is answered promptly, but the slot is released only when the task's work has actually
 * settled — so a still-running decode or helper process is never overlapped by the next one.
 */
export class MediaQueue {
  private readonly limits: Record<Lane, number>;
  private readonly active: Record<Lane, number> = { metadata: 0, image: 0 };
  private readonly waiting: Record<Lane, Task[]> = { metadata: [], image: [] };
  private readonly running = new Set<Task>();
  private readonly cancelled = new Set<JobId>();
  readonly peak: Record<Lane, number> = { metadata: 0, image: 0 };

  constructor(private readonly opts: { metadataJobs: number; imageJobs: number; timeoutMs: number }) {
    this.limits = { metadata: Math.max(1, opts.metadataJobs), image: Math.max(1, opts.imageJobs) };
  }

  run<T>(lane: Lane, jobId: JobId, fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T>> {
    if (this.cancelled.has(jobId)) return Promise.resolve(cancelledResult());
    return new Promise<Result<T>>((resolve) => {
      this.waiting[lane].push({ jobId, run: fn, resolve: resolve as (r: Result<unknown>) => void, controller: new AbortController() });
      this.pump(lane);
    });
  }

  cancelJob(jobId: JobId): void {
    this.cancelled.add(jobId);
    for (const lane of ['metadata', 'image'] as const) {
      const keep: Task[] = [];
      for (const t of this.waiting[lane]) {
        if (t.jobId === jobId) t.resolve(cancelledResult());
        else keep.push(t);
      }
      this.waiting[lane] = keep;
    }
    for (const t of this.running) if (t.jobId === jobId) t.controller.abort();
  }

  isCancelled(jobId: JobId): boolean {
    return this.cancelled.has(jobId);
  }

  pending(): number {
    return this.waiting.metadata.length + this.waiting.image.length + this.active.metadata + this.active.image;
  }

  private pump(lane: Lane): void {
    while (this.active[lane] < this.limits[lane] && this.waiting[lane].length > 0) {
      const task = this.waiting[lane].shift()!;
      this.active[lane]++;
      this.peak[lane] = Math.max(this.peak[lane], this.active[lane]);
      void this.execute(lane, task);
    }
  }

  private async execute(lane: Lane, task: Task): Promise<void> {
    this.running.add(task);
    let answered = false;
    const answer = (r: Result<unknown>) => {
      if (answered) return;
      answered = true;
      task.resolve(r);
    };
    const timer = setTimeout(() => {
      task.controller.abort();
      answer({ ok: false, code: 'TIMEOUT', message: `Quá thời gian xử lý (${this.opts.timeoutMs} ms).` });
    }, this.opts.timeoutMs);
    const onAbort = () => {
      if (this.cancelled.has(task.jobId)) answer(cancelledResult());
    };
    task.controller.signal.addEventListener('abort', onAbort);
    let result: Result<unknown>;
    try {
      result = { ok: true, value: await task.run(task.controller.signal) };
    } catch (e) {
      result = { ok: false, code: 'TASK_ERROR', message: (e as Error)?.message ?? String(e) };
    }
    clearTimeout(timer);
    task.controller.signal.removeEventListener('abort', onAbort);
    answer(this.cancelled.has(task.jobId) ? cancelledResult() : result);
    // Only now is the work really over: free the slot.
    this.running.delete(task);
    this.active[lane]--;
    this.pump(lane);
  }
}

function cancelledResult<T>(): Result<T> {
  return { ok: false, code: 'CANCELLED', message: 'Tác vụ đã bị hủy.' };
}
