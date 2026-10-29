import { createHash, randomUUID } from 'node:crypto';

// ---------- contracts ----------
export interface TokenRecord {
  userId: string;
  label: string;
  active: boolean;
  userMonthlyLimit: number;
}

export interface ProviderFace {
  boundingBox: { left: number; top: number; width: number; height: number };
  confidence: number;
  pose: { yaw: number; pitch: number; roll: number } | null;
  quality: { sharpness: number; brightness: number } | null;
  eyesOpen: { value: boolean; confidence: number } | null;
  smile: { value: boolean; confidence: number } | null;
  mouthOpen: { value: boolean; confidence: number } | null;
  sunglasses: { value: boolean; confidence: number } | null;
  eyeglasses: { value: boolean; confidence: number } | null;
  faceOccluded: { value: boolean; confidence: number } | null;
  eyeDirection: { yaw: number; pitch: number; confidence: number } | null;
  emotions: { type: string; confidence: number }[];
}

export interface AnalysisResult {
  provider: 'aws-rekognition-detectfaces';
  providerApi: 'DetectFaces/2016-06-27';
  imageSha256: string;
  analyzedAt: string;
  faces: ProviderFace[];
}

export interface RequestRecord {
  requestId: string;
  userId: string;
  imageSha256: string;
  status: 'reserving' | 'processing' | 'done' | 'failed';
  createdAt: number;
  ttl: number;
  result?: AnalysisResult;
  errorCode?: string;
  /** Random per-invocation value: lets a retried conditional create recognise its own write. */
  owner?: string;
}

export type QuotaResult = 'ok' | 'global-exhausted' | 'user-exhausted' | 'conflict';

export interface Store {
  getToken(tokenHash: string): Promise<TokenRecord | null>;
  /** Conditional create: 'exists' when the request ID is already known. */
  createRequest(rec: RequestRecord): Promise<'created' | 'exists'>;
  /** Conditional overwrite only if the observed record has not advanced or been replaced. */
  replaceRequest(rec: RequestRecord, previous: RequestRecord): Promise<boolean>;
  /** processing → failed(ABANDONED), only if still processing. The quota unit stays used. */
  abandonRequest(requestId: string, ttl: number, createdAt: number): Promise<void>;
  getRequest(requestId: string): Promise<RequestRecord | null>;
  /** One transaction: +1 shared and personal usage within limits, and reserving → processing. */
  reserveQuota(a: { requestId: string; userId: string; owner: string; month: string; globalLimit: number; userLimit: number }): Promise<QuotaResult>;
  /** Removes a request that never reached AWS (quota refused), so the key can be used again. */
  releaseReservation(requestId: string, owner: string): Promise<void>;
  completeRequest(requestId: string, result: AnalysisResult, ttl: number, owner: string): Promise<void>;
  failRequest(requestId: string, errorCode: string, ttl: number, owner: string): Promise<void>;
  getQuota(userId: string, month: string): Promise<{ globalUsed: number; userUsed: number }>;
}

export interface FaceProvider {
  detectFaces(jpeg: Uint8Array): Promise<ProviderFace[]>;
}

export interface AppConfig {
  globalMonthlyLimit: number;
  maxImageBytes: number;
  resultTtlHours: number;
  now(): number;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export interface HttpResponse {
  status: number;
  body: unknown;
}

// ---------- helpers ----------
export const hashToken = (token: string): string => createHash('sha256').update(`eventstory-token:${token}`).digest('hex');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const nextMonthStart = (ms: number): string => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const err = (status: number, error: string, message: string): HttpResponse => ({ status, body: { error, message } });
/** A record still 'reserving' after this never got its quota unit (the invocation died): safe to take over. */
export const ABANDONED_RESERVING_MS = 60_000;
/** Lambda timeout is 45 s: a record still 'processing' after this will never complete. */
export const ABANDONED_PROCESSING_MS = 120_000;

function view(r: RequestRecord): unknown {
  if (r.status === 'done') return { requestId: r.requestId, status: 'done', ...r.result };
  if (r.status === 'failed') return { requestId: r.requestId, status: 'failed', imageSha256: r.imageSha256, errorCode: r.errorCode };
  return { requestId: r.requestId, status: 'processing', imageSha256: r.imageSha256 };
}

async function authenticate(req: HttpRequest, store: Store): Promise<TokenRecord | null> {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,200})$/.exec(h);
  if (!m) return null;
  const t = await store.getToken(hashToken(m[1]!));
  return t && t.active ? t : null;
}

/** A record stuck in 'processing' past the Lambda timeout is reported (and stored) as failed. */
async function settleAbandoned(r: RequestRecord, store: Store, now: number, config: AppConfig): Promise<RequestRecord> {
  if (r.status !== 'processing' || now - r.createdAt <= ABANDONED_PROCESSING_MS) return r;
  await store.abandonRequest(r.requestId, Math.floor(now / 1000) + config.resultTtlHours * 3600, r.createdAt);
  return (await store.getRequest(r.requestId)) ?? { ...r, status: 'failed', errorCode: 'ABANDONED' };
}

// ---------- handler ----------
/**
 * Pilot API. Order of checks guarantees that no AWS call happens for: a bad token, a missing
 * idempotency key, an oversized or non-JPEG body, an existing key (replayed or conflicting), or a
 * used-up quota. A quota unit is reserved in a transaction before the single AWS call and is not
 * refunded once that call has started. Images are never stored or logged.
 */
export async function handle(req: HttpRequest, deps: { store: Store; provider: FaceProvider; config: AppConfig }): Promise<HttpResponse> {
  const { store, provider, config } = deps;
  const now = config.now();
  const user = await authenticate(req, store);
  if (!user) return err(401, 'UNAUTHORIZED', 'Token không hợp lệ hoặc đã bị thu hồi.');

  if (req.method === 'GET' && req.path === '/v1/quota') {
    const month = monthOf(now);
    const q = await store.getQuota(user.userId, month);
    return {
      status: 200,
      body: {
        month,
        resetAt: nextMonthStart(now),
        user: { used: q.userUsed, limit: user.userMonthlyLimit },
        global: { used: q.globalUsed, limit: config.globalMonthlyLimit },
      },
    };
  }

  const reqMatch = /^\/v1\/requests\/([^/]+)$/.exec(req.path);
  if (req.method === 'GET' && reqMatch) {
    const id = reqMatch[1]!;
    if (!REQUEST_ID_RE.test(id)) return err(404, 'NOT_FOUND', 'Không có yêu cầu này.');
    let r = await store.getRequest(id);
    // Results stop being readable after 24 h even if TTL cleanup has not run yet.
    if (!r || r.userId !== user.userId || now - r.createdAt > config.resultTtlHours * 3600_000) return err(404, 'NOT_FOUND', 'Không có yêu cầu này hoặc đã hết hạn.');
    // The app re-POSTs the same key on 404, which safely takes over this never-charged reservation.
    if (r.status === 'reserving' && now - r.createdAt > ABANDONED_RESERVING_MS) return err(404, 'NOT_FOUND', 'Yêu cầu giữ chỗ đã bị gián đoạn; gửi lại cùng key.');
    r = await settleAbandoned(r, store, now, config);
    return { status: 200, body: view(r) };
  }

  if (req.method === 'POST' && req.path === '/v1/face-analysis') {
    const key = req.headers['idempotency-key'] ?? '';
    if (!KEY_RE.test(key)) return err(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Thiếu hoặc sai Idempotency-Key.');
    if (req.body.length > config.maxImageBytes) return err(413, 'IMAGE_TOO_LARGE', `Ảnh vượt ${config.maxImageBytes} byte.`);
    if (!isJpeg(req.body)) return err(415, 'NOT_JPEG', 'Chỉ nhận JPEG.');
    const imageSha256 = sha256(req.body);
    const requestId = createHash('sha256').update(`${user.userId}:${key}`).digest('hex').slice(0, 32);
    const ttl = Math.floor(now / 1000) + config.resultTtlHours * 3600;

    const owner = randomUUID();
    const fresh: RequestRecord = { requestId, userId: user.userId, imageSha256, status: 'reserving', createdAt: now, ttl, owner };
    const created = await store.createRequest(fresh);
    if (created === 'exists') {
      let existing = await store.getRequest(requestId);
      if (!existing) return err(503, 'BUSY', 'Yêu cầu đang thay đổi, thử lại sau.');
      const expired = now - existing.createdAt > config.resultTtlHours * 3600_000;
      const abandoned = existing.status === 'reserving' && now - existing.createdAt > ABANDONED_RESERVING_MS;
      if (expired || abandoned) {
        // Older than 24 h (not readable any more) or never reached AWS: a new request under the same key.
        if (!(await store.replaceRequest(fresh, existing))) return err(503, 'BUSY', 'Yêu cầu đang thay đổi, thử lại sau.');
      } else {
        if (existing.imageSha256 !== imageSha256) return err(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho một ảnh khác.');
        existing = await settleAbandoned(existing, store, now, config);
        if (existing.status === 'done' || existing.status === 'failed') return { status: 200, body: view(existing) };
        return { status: 202, body: view(existing) };
      }
    }

    const month = monthOf(now);
    const reserved = await store.reserveQuota({ requestId, userId: user.userId, owner, month, globalLimit: config.globalMonthlyLimit, userLimit: user.userMonthlyLimit });
    if (reserved !== 'ok') {
      await store.releaseReservation(requestId, owner);
      if (reserved === 'global-exhausted') return err(429, 'GLOBAL_QUOTA_EXHAUSTED', 'Hết lượt phân tích chung của pilot trong tháng.');
      if (reserved === 'user-exhausted') return err(429, 'USER_QUOTA_EXHAUSTED', 'Hết lượt phân tích của bạn trong tháng.');
      // Transient transaction conflict: nothing was counted or sent, the key is free again.
      return { status: 503, body: { error: 'BUSY', message: 'Máy chủ đang bận, thử lại sau.', retryAfterSeconds: 2 } };
    }

    try {
      const faces = await provider.detectFaces(req.body);
      const result: AnalysisResult = {
        provider: 'aws-rekognition-detectfaces',
        providerApi: 'DetectFaces/2016-06-27',
        imageSha256,
        analyzedAt: new Date(config.now()).toISOString(),
        faces,
      };
      await store.completeRequest(requestId, result, ttl, owner);
      return { status: 200, body: { requestId, status: 'done', ...result } };
    } catch (e) {
      const code = (e as Error)?.name || 'PROVIDER_ERROR';
      await store.failRequest(requestId, code, ttl, owner);
      return { status: 502, body: { requestId, status: 'failed', imageSha256, errorCode: code } };
    }
  }

  return err(404, 'NOT_FOUND', 'Không có endpoint này.');
}
