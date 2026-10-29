import type { QuotaResult, RequestRecord, Store, TokenRecord } from '../src/app';

const tick = () => new Promise((r) => setImmediate(r));

/**
 * In-memory Store with the same conditional semantics as the DynamoDB implementation
 * (conditional put, transactional quota reservation). Each method yields to the event loop
 * first so concurrent callers interleave like real network calls.
 */
export class MemoryStore implements Store {
  tokens = new Map<string, TokenRecord>();
  requests = new Map<string, RequestRecord>();
  quota = new Map<string, number>();

  async getToken(hash: string) {
    await tick();
    return this.tokens.get(hash) ?? null;
  }
  async createRequest(rec: RequestRecord) {
    await tick();
    if (this.requests.has(rec.requestId)) return 'exists' as const;
    this.requests.set(rec.requestId, { ...rec });
    return 'created' as const;
  }
  async replaceRequest(rec: RequestRecord, previous: RequestRecord) {
    await tick();
    const current = this.requests.get(rec.requestId);
    if (!current || current.createdAt !== previous.createdAt || current.status !== previous.status || current.owner !== previous.owner) return false;
    this.requests.set(rec.requestId, { ...rec });
    return true;
  }
  async abandonRequest(id: string, ttl: number, createdAt: number) {
    await tick();
    const r = this.requests.get(id);
    if (r?.status === 'processing' && r.createdAt === createdAt) Object.assign(r, { status: 'failed', errorCode: 'ABANDONED', ttl });
  }
  async getRequest(id: string) {
    await tick();
    const r = this.requests.get(id);
    return r ? { ...r } : null;
  }
  async reserveQuota(a: { requestId: string; userId: string; owner: string; month: string; globalLimit: number; userLimit: number }): Promise<QuotaResult> {
    await tick();
    const g = this.quota.get(`G#${a.month}`) ?? 0;
    const u = this.quota.get(`U#${a.userId}#${a.month}`) ?? 0;
    const req = this.requests.get(a.requestId);
    if (g >= a.globalLimit) return 'global-exhausted';
    if (u >= a.userLimit) return 'user-exhausted';
    if (!req || req.status !== 'reserving' || req.owner !== a.owner) return 'conflict';
    this.quota.set(`G#${a.month}`, g + 1);
    this.quota.set(`U#${a.userId}#${a.month}`, u + 1);
    req.status = 'processing';
    return 'ok';
  }
  async releaseReservation(id: string, owner: string) {
    await tick();
    if (this.requests.get(id)?.status === 'reserving' && this.requests.get(id)?.owner === owner) this.requests.delete(id);
  }
  async completeRequest(id: string, result: RequestRecord['result'], ttl: number, owner: string) {
    await tick();
    const r = this.requests.get(id)!;
    if (r.owner !== owner) throw new Error('Reservation owner changed');
    Object.assign(r, { status: 'done', result, ttl });
  }
  async failRequest(id: string, errorCode: string, ttl: number, owner: string) {
    await tick();
    const r = this.requests.get(id)!;
    if (r.owner !== owner) throw new Error('Reservation owner changed');
    Object.assign(r, { status: 'failed', errorCode, ttl });
  }
  async getQuota(userId: string, month: string) {
    await tick();
    return { globalUsed: this.quota.get(`G#${month}`) ?? 0, userUsed: this.quota.get(`U#${userId}#${month}`) ?? 0 };
  }
}
