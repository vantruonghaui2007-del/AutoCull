import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, hashToken, type AppConfig, type FaceProvider, type HttpRequest, type ProviderFace } from '../src/app';
import { MemoryStore } from './memory-store';

const TOKEN = 'pilot-token-0123456789abcdef0123456789abcdef';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7), 0xff, 0xd9]);
const OTHER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(9), 0xff, 0xd9]);

class CountingProvider implements FaceProvider {
  calls = 0;
  fail = false;
  delayMs = 20;
  async detectFaces(): Promise<ProviderFace[]> {
    this.calls++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw Object.assign(new Error('boom'), { name: 'ThrottlingException' });
    return [
      {
        boundingBox: { left: 0.4, top: 0.2, width: 0.1, height: 0.15 },
        confidence: 99.9,
        pose: { yaw: 3, pitch: -2, roll: 1 },
        quality: { sharpness: 80, brightness: 60 },
        eyesOpen: { value: false, confidence: 97 },
        smile: { value: true, confidence: 90 },
        mouthOpen: { value: false, confidence: 95 },
        sunglasses: { value: false, confidence: 99 },
        eyeglasses: { value: false, confidence: 99 },
        faceOccluded: { value: false, confidence: 98 },
        eyeDirection: { yaw: 1, pitch: 0, confidence: 90 },
        emotions: [{ type: 'HAPPY', confidence: 88 }],
      },
    ];
  }
}

let store: MemoryStore;
let provider: CountingProvider;
let now = Date.UTC(2026, 9, 28, 10, 0, 0);
const config = (): AppConfig => ({ globalMonthlyLimit: 4000, maxImageBytes: 2.5 * 1024 * 1024, resultTtlHours: 24, now: () => now });
const deps = () => ({ store, provider, config: config() });
const post = (body: Uint8Array, key = 'key-0000000000000001', token = TOKEN): HttpRequest => ({
  method: 'POST',
  path: '/v1/face-analysis',
  headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'image/jpeg' },
  body,
});

beforeEach(() => {
  store = new MemoryStore();
  provider = new CountingProvider();
  now = Date.UTC(2026, 9, 28, 10, 0, 0);
  store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'Pilot 1', active: true, userMonthlyLimit: 1000 });
});

describe('POST /v1/face-analysis', () => {
  it('returns eyes/smile/pose for a valid request and counts one quota unit', async () => {
    const r = await handle(post(JPEG), deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'done', imageSha256: createHash('sha256').update(JPEG).digest('hex') });
    expect((r.body as { faces: ProviderFace[] }).faces[0]!.eyesOpen).toEqual({ value: false, confidence: 97 });
    expect(provider.calls).toBe(1);
    const q = await handle({ method: 'GET', path: '/v1/quota', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array() }, deps());
    expect(q.body).toMatchObject({ user: { used: 1, limit: 1000 }, global: { used: 1, limit: 4000 } });
  });

  it('never calls AWS for a wrong token, a missing key, a too-large or non-JPEG body', async () => {
    expect((await handle(post(JPEG, 'key-0000000000000001', 'wrong-token-xxxxxxxxxxxxxxxx'), deps())).status).toBe(401);
    expect((await handle({ ...post(JPEG), headers: { authorization: `Bearer ${TOKEN}` } }, deps())).status).toBe(400);
    const big = new Uint8Array(2.5 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await handle(post(big), deps())).status).toBe(413);
    expect((await handle(post(new Uint8Array([1, 2, 3, 4])), deps())).status).toBe(415);
    expect(provider.calls).toBe(0);
  });

  it('two concurrent requests with the same key make exactly one AWS call', async () => {
    const [a, b] = await Promise.all([handle(post(JPEG), deps()), handle(post(JPEG), deps())]);
    expect(provider.calls).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const again = await handle(post(JPEG), deps());
    expect(again).toMatchObject({ status: 200, body: { status: 'done' } });
    expect(provider.calls).toBe(1);
    expect((await store.getQuota('u1', '2026-10')).userUsed).toBe(1);
  });

  it('rejects the same key with a different image (409) without calling AWS', async () => {
    await handle(post(JPEG), deps());
    const r = await handle(post(OTHER_JPEG), deps());
    expect(r.status).toBe(409);
    expect(provider.calls).toBe(1);
  });

  it('refuses when the personal or the shared quota is used up, without calling AWS', async () => {
    store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'Pilot 1', active: true, userMonthlyLimit: 1 });
    expect((await handle(post(JPEG, 'key-a000000000000001'), deps())).status).toBe(200);
    const r = await handle(post(OTHER_JPEG, 'key-a000000000000002'), deps());
    expect(r).toMatchObject({ status: 429, body: { error: 'USER_QUOTA_EXHAUSTED' } });
    store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'Pilot 1', active: true, userMonthlyLimit: 1000 });
    const shared = await handle(post(OTHER_JPEG, 'key-a000000000000003'), { ...deps(), config: { ...config(), globalMonthlyLimit: 1 } });
    expect(shared).toMatchObject({ status: 429, body: { error: 'GLOBAL_QUOTA_EXHAUSTED' } });
    expect(provider.calls).toBe(1);
    // A quota refusal made no AWS call, so the same key can be used again later.
    const later = await handle(post(OTHER_JPEG, 'key-a000000000000002'), deps());
    expect(later.status).toBe(200);
  });

  it('a failed AWS call keeps its quota unit and is not retried silently for the same key', async () => {
    provider.fail = true;
    const r = await handle(post(JPEG), deps());
    expect(r).toMatchObject({ status: 502, body: { status: 'failed', errorCode: 'ThrottlingException' } });
    provider.fail = false;
    const again = await handle(post(JPEG), deps());
    expect(again).toMatchObject({ status: 200, body: { status: 'failed' } });
    expect(provider.calls).toBe(1);
    expect((await store.getQuota('u1', '2026-10')).userUsed).toBe(1);
  });

  it('a revoked token is refused', async () => {
    store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'Pilot 1', active: false, userMonthlyLimit: 1000 });
    expect((await handle(post(JPEG), deps())).status).toBe(401);
    expect(provider.calls).toBe(0);
  });
});

describe('GET /v1/requests/:id', () => {
  it('reads the stored result without calling AWS again, only for its owner, and only for 24 hours', async () => {
    const created = await handle(post(JPEG), deps());
    const requestId = (created.body as { requestId: string }).requestId;
    const get = (token = TOKEN) => handle({ method: 'GET', path: `/v1/requests/${requestId}`, headers: { authorization: `Bearer ${token}` }, body: new Uint8Array() }, deps());
    expect(await get()).toMatchObject({ status: 200, body: { status: 'done' } });
    store.tokens.set(hashToken('other-token-0123456789abcdef0123456789'), { userId: 'u2', label: 'P2', active: true, userMonthlyLimit: 1000 });
    expect((await get('other-token-0123456789abcdef0123456789')).status).toBe(404);
    now += 25 * 3600 * 1000;
    expect((await get()).status).toBe(404);
    expect(provider.calls).toBe(1);
  });
});

describe('GET /v1/quota', () => {
  it('reports reset time at the start of next month (UTC)', async () => {
    const q = await handle({ method: 'GET', path: '/v1/quota', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array() }, deps());
    expect(q.body).toMatchObject({ month: '2026-10', resetAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('recovery and the 24 h window (review findings)', () => {
  it('only one invocation can take over an abandoned reservation', async () => {
    const key = 'key-abandoned-race-001';
    const id = rid(key);
    store.requests.set(id, { requestId: id, userId: 'u1', imageSha256: createHash('sha256').update(JPEG).digest('hex'), status: 'reserving', createdAt: now - 61_000, ttl: 0, owner: 'dead' });
    const results = await Promise.all([handle(post(JPEG, key), deps()), handle(post(JPEG, key), deps())]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(provider.calls).toBe(1);
    expect(store.quota.get('U#u1#2026-10')).toBe(1);
  });
  const get = (id: string): HttpRequest => ({ method: 'GET', path: `/v1/requests/${id}`, headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array() });
  const rid = (key: string) => createHash('sha256').update(`u1:${key}`).digest('hex').slice(0, 32);

  it('after 24 h the same key no longer replays the old result: it is a new request', async () => {
    await handle(post(JPEG), deps());
    now += 25 * 3600_000;
    const r = await handle(post(JPEG), deps());
    expect(r.status).toBe(200);
    expect(provider.calls).toBe(2);
  });

  it('a request abandoned before its quota was reserved is taken over after 60 s, without double counting', async () => {
    const key = 'key-abandoned-0000001';
    store.requests.set(rid(key), { requestId: rid(key), userId: 'u1', imageSha256: createHash('sha256').update(JPEG).digest('hex'), status: 'reserving', createdAt: now, ttl: 0, owner: 'dead' });
    expect((await handle(post(JPEG, key), deps())).status).toBe(202);
    now += 61_000;
    expect((await handle(get(rid(key)), deps())).status).toBe(404);
    const r = await handle(post(JPEG, key), deps());
    expect(r).toMatchObject({ status: 200, body: { status: 'done' } });
    expect(provider.calls).toBe(1);
    expect(store.quota.get('U#u1#2026-10')).toBe(1);
  });

  it('a request stuck in processing (Lambda died mid-call) becomes failed without a new AWS call', async () => {
    const key = 'key-stuck-00000000001';
    store.requests.set(rid(key), { requestId: rid(key), userId: 'u1', imageSha256: createHash('sha256').update(JPEG).digest('hex'), status: 'processing', createdAt: now, ttl: 0, owner: 'dead' });
    now += 5 * 60_000;
    expect((await handle(get(rid(key)), deps())).body).toMatchObject({ status: 'failed', errorCode: 'ABANDONED' });
    expect((await handle(post(JPEG, key), deps())).body).toMatchObject({ status: 'failed', errorCode: 'ABANDONED' });
    expect(provider.calls).toBe(0);
  });

  it('a transient quota conflict answers 503 (retry later), releases the key and calls nothing', async () => {
    const reserve = store.reserveQuota.bind(store);
    store.reserveQuota = async () => 'conflict';
    const r = await handle(post(JPEG, 'key-conflict-00000001'), deps());
    expect(r.status).toBe(503);
    expect(provider.calls).toBe(0);
    store.reserveQuota = reserve;
    expect((await handle(post(JPEG, 'key-conflict-00000001'), deps())).status).toBe(200);
  });
});
