import { describe, expect, it } from 'vitest';
import { MediaQueue } from '../../src/worker/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JOB = 'j_00000000-0000-4000-8000-000000000001';

describe('MediaQueue slots', () => {
  it('a timed-out task keeps its slot until its work has really ended', async () => {
    const q = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 50 });
    let aEnded = 0;
    let aStillRunningWhenBStarted: boolean | null = null;
    const a = q.run('image', JOB, async () => {
      await sleep(300); // ignores the abort signal, like a Sharp call
      aEnded = Date.now();
    });
    const b = q.run('image', JOB, async () => {
      aStillRunningWhenBStarted = aEnded === 0;
    });
    const t0 = Date.now();
    expect(await a).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(250); // the caller hears about the timeout promptly
    await b;
    expect(aStillRunningWhenBStarted).toBe(false);
    expect(q.peak.image).toBe(1);
  });

  it('timeout aborts the task signal so a cooperative task (helper process) can stop', async () => {
    const q = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 50 });
    let aborted = false;
    const r = await q.run('image', JOB, (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve()))));
    expect(r).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(aborted).toBe(true);
  });

  it('cancelling a job aborts its running task and frees the slot only after it settles', async () => {
    const q = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 10_000 });
    let settled = 0;
    let nextStarted = 0;
    const running = q.run('image', JOB, (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            settled = Date.now();
            resolve();
          }, 80);
        }),
      ),
    );
    const other = q.run('image', 'j_00000000-0000-4000-8000-000000000002', async () => {
      nextStarted = Date.now();
    });
    await sleep(20);
    q.cancelJob(JOB);
    expect(await running).toMatchObject({ ok: false, code: 'CANCELLED' });
    await other;
    expect(nextStarted).toBeGreaterThanOrEqual(settled);
  });
});
