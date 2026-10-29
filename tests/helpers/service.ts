import type { ProgressEvent } from '../../src/shared/contracts';
import { createService, type Service } from '../../src/worker/service';
import type { LocalDetect } from '../../src/worker/local-analysis';

export interface TestService {
  service: Service;
  events: ProgressEvent[];
  waitForJob(jobId: string, timeoutMs?: number): Promise<'complete' | 'cancelled'>;
  waitFor(pred: (e: ProgressEvent) => boolean, timeoutMs?: number): Promise<ProgressEvent>;
}

export function makeService(totalMemBytes = 16 * 1024 ** 3, localDetect?: LocalDetect): TestService {
  const events: ProgressEvent[] = [];
  const listeners = new Set<(e: ProgressEvent) => void>();
  const service = createService({
    totalMemBytes,
    localDetect,
    emit: (e) => {
      events.push(e);
      for (const l of listeners) l(e);
    },
  });
  const waitFor = (pred: (e: ProgressEvent) => boolean, timeoutMs = 120_000) =>
    new Promise<ProgressEvent>((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => {
        listeners.delete(l);
        reject(new Error('timeout waiting for event'));
      }, timeoutMs);
      const l = (e: ProgressEvent) => {
        if (pred(e)) {
          clearTimeout(timer);
          listeners.delete(l);
          resolve(e);
        }
      };
      listeners.add(l);
    });
  return {
    service,
    events,
    waitFor,
    async waitForJob(jobId, timeoutMs) {
      const e = await waitFor(
        (x) => (x.kind === 'scan' || x.kind === 'export') && x.jobId === jobId && (x.phase === 'complete' || x.phase === 'cancelled'),
        timeoutMs,
      );
      return (e as { phase: 'complete' | 'cancelled' }).phase;
    },
  };
}

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}
