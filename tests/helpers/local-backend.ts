import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { handle, hashToken, type FaceProvider, type ProviderFace } from '../../backend/src/app';
import { MemoryStore } from '../../backend/tests/memory-store';

/**
 * The real backend handler on 127.0.0.1 with an in-memory store and a replaced provider.
 * Logic checks only: this proves nothing about AWS.
 */
export async function startLocalBackend(provider: FaceProvider, token: string, userLimit = 1000) {
  const store = new MemoryStore();
  store.tokens.set(hashToken(token), { userId: 'u1', label: 'local', active: true, userMonthlyLimit: userLimit });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r = await handle(
        { method: req.method!, path: req.url!, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) },
        { store, provider, config: { globalMonthlyLimit: 4000, maxImageBytes: 2.5 * 1024 * 1024, resultTtlHours: 24, now: () => Date.now() } },
      );
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, close: () => server.close() };
}

/** One frontal face per image; eyes are "closed" when the frame is reddish (known outcome per test photo). */
export const colourCodedProvider = (calls: { n: number }): FaceProvider => ({
  async detectFaces(jpeg): Promise<ProviderFace[]> {
    calls.n++;
    const { channels } = await sharp(Buffer.from(jpeg)).stats();
    const reddish = channels[0]!.mean > channels[2]!.mean + 40;
    return [
      {
        boundingBox: { left: 0.3, top: 0.25, width: 0.3, height: 0.45 },
        confidence: 99.9,
        pose: { yaw: 0, pitch: 0, roll: 0 },
        quality: { sharpness: 80, brightness: 60 },
        eyesOpen: { value: !reddish, confidence: 98 },
        smile: { value: reddish, confidence: 95 },
        mouthOpen: { value: false, confidence: 95 },
        sunglasses: { value: false, confidence: 99 },
        eyeglasses: { value: false, confidence: 99 },
        faceOccluded: { value: false, confidence: 99 },
        eyeDirection: null,
        emotions: [{ type: 'CALM', confidence: 80 }],
      },
    ];
  },
});
