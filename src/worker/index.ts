import type { ProgressEvent, Result } from '../shared/contracts';
import type { WorkerMessage, WorkerRequest, LocalDetectResponse } from '../shared/rpc';
import type { LocalInference } from '../shared/local-analysis';
import { createService } from './service';

const port = process.parentPort;

function send(msg: WorkerMessage): void {
  port.postMessage(msg);
}

let localId = 0;
const localPending = new Map<number, (r: Result<LocalInference>) => void>();
const service = createService({
  emit: (event: ProgressEvent) => send({ event }),
  localDetect: (jpeg, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('CANCELLED')); return; }
    const id = ++localId;
    const abort = () => { localPending.delete(id); clearTimeout(timer); reject(new Error('CANCELLED')); };
    const timer = setTimeout(() => { localPending.delete(id); signal.removeEventListener('abort', abort); reject(new Error('LOCAL_TIMEOUT')); }, 100_000);
    signal.addEventListener('abort', abort, { once: true });
    localPending.set(id, (r) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (r.ok) resolve(r.value); else reject(new Error(r.message));
    });
    send({ localDetect: id, jpeg });
  }),
});

port.on('message', (e: { data: WorkerRequest | LocalDetectResponse }) => {
  if ('localResult' in e.data) {
    const id = e.data.localResult;
    localPending.get(id)?.(e.data.result);
    localPending.delete(id);
    return;
  }
  const { id, method, params } = e.data;
  void (async () => {
    let result: Result<unknown>;
    const fn = (service as unknown as Record<string, ((...a: unknown[]) => Promise<Result<unknown>>) | undefined>)[method];
    if (typeof fn !== 'function') {
      result = { ok: false, code: 'NOT_IMPLEMENTED', message: `Chưa hỗ trợ: ${method}` };
    } else {
      try {
        result = await fn.apply(service, params);
      } catch (err) {
        result = { ok: false, code: 'INTERNAL', message: (err as Error).message };
      }
    }
    send({ id, result });
    if (method === 'shutdown') setTimeout(() => process.exit(0), 50);
  })();
});

send({ ready: true });
