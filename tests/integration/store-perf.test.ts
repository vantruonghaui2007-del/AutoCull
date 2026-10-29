import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectStore } from '../../src/project/store';
import { pairCandidatesOf } from '../../src/worker/review';
import { makeTempDir } from '../helpers/fs';

// Work done per user command must stay bounded with thousands of photos (review finding I6).
let store: ProjectStore;
const N = 5000;

beforeAll(async () => {
  const dir = path.join(await makeTempDir('store-perf'), 'p');
  const r = ProjectStore.create(dir, 'Perf');
  if (!r.ok) throw new Error(r.message);
  store = r.value;
  const src = store.addSource(dir, 'synthetic');
  store.tx(() => {
    for (let i = 0; i < N; i++) {
      const raw = i % 2 === 0;
      const f = store.insertFile({
        sourceId: src.id,
        relativePath: `DCIM/IMG_${String(Math.floor(i / 2)).padStart(5, '0')}.${raw ? 'ARW' : 'JPG'}`,
        kind: raw ? 'raw' : 'jpeg',
        bytes: 1000 + i,
        mtimeMs: 0,
        sampledHash: String(i).padStart(64, '0'),
      });
      store.insertAsset(f.id);
      store.saveMetadata(
        f.id,
        {
          cameraId: null,
          cameraMake: 'SONY',
          cameraModel: 'ILCE-7C',
          cameraSerial: null,
          capturedLocal: '2026-01-01T10:00:00',
          explicitOffsetMinutes: null,
          timeSource: 'exif-no-zone',
          orientation: 1,
        },
        String(i).padStart(64, '0'),
        null,
      );
    }
  });
});

afterAll(() => store?.close());

it('lists pair candidates for 5,000 assets in well under a second', () => {
  const t0 = performance.now();
  const c = pairCandidatesOf(store);
  const ms = performance.now() - t0;
  expect(c.length).toBe(N / 2);
  expect(ms).toBeLessThan(300);
});

it('serves a 200-item page quickly, including the LRU touch', () => {
  store.queryAssets({ offset: 0, limit: 200 }, () => null); // warm up
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) store.queryAssets({ offset: i * 200, limit: 200 }, () => null);
  const perPage = (performance.now() - t0) / 10;
  expect(perPage).toBeLessThan(60);
});
