import { expect, test } from '@playwright/test';
import { copyFile, mkdir } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { handle, hashToken, type FaceProvider, type ProviderFace } from '../../backend/src/app';
import { MemoryStore } from '../../backend/tests/memory-store';
import { launchTestApp, stubOpenDialogs, type TestApp } from '../helpers/electron';
import { fixturePath, loadFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';

// UI wiring check against the real backend logic running locally; Rekognition is replaced.
const TOKEN = 'ui-pilot-token-0123456789abcdef0123456789ab';
const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let server: Server;
let endpoint: string;
let t: TestApp;
let userData: string;
const calls: number[] = [];

const provider: FaceProvider = {
  async detectFaces(jpeg): Promise<ProviderFace[]> {
    calls.push(jpeg.length);
    return [
      {
        boundingBox: { left: 0.4, top: 0.2, width: 0.08, height: 0.12 },
        confidence: 99.8,
        pose: { yaw: 1, pitch: 0, roll: 0 },
        quality: { sharpness: 80, brightness: 55 },
        eyesOpen: { value: false, confidence: 97 },
        smile: { value: false, confidence: 90 },
        mouthOpen: { value: false, confidence: 90 },
        sunglasses: { value: false, confidence: 99 },
        eyeglasses: { value: false, confidence: 99 },
        faceOccluded: { value: false, confidence: 99 },
        eyeDirection: null,
        emotions: [{ type: 'CALM', confidence: 80 }],
      },
    ];
  },
};

test.beforeAll(async () => {
  const store = new MemoryStore();
  store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'ui', active: true, userMonthlyLimit: 1000 });
  server = http.createServer((req, res) => {
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
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = await makeTempDir('e2e-ai');
  userData = path.join(base, 'userdata');
  const card = path.join(base, 'card');
  await mkdir(card, { recursive: true });
  await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, 'A.JPG'));
  await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'B.JPG'));
  const parent = path.join(base, 'projects');
  await mkdir(parent);
  t = await launchTestApp({ EVENTSTORY_USER_DATA: userData });
  await stubOpenDialogs(t.app, [parent, card]);
  await t.page.getByTestId('new-project-name').fill('AI UI');
  await t.page.getByTestId('create-project').click();
  await t.page.getByTestId('add-source').click();
  await expect(t.page.getByTestId('count-assets')).toHaveText(/^2 ảnh/, { timeout: 60_000 });
  await t.page.getByTestId('scan-idle').waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await t?.close();
  server?.close();
});

test('analysis needs settings and consent, then shows eye state per face', async () => {
  const page = t.page;
  await page.getByTestId('asset-cell').first().click();
  await expect(page.getByTestId('face-summary')).toContainText('Chưa phân tích');
  await page.getByTestId('open-ai-settings').click();
  await page.getByTestId('ai-endpoint').fill(endpoint);
  await page.getByTestId('ai-token').fill(TOKEN);
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-status')).toContainText('Đã lưu');
  await expect(page.getByTestId('ai-quota')).toContainText('0/1000');
  await page.getByTestId('ai-close').click();

  await page.getByTestId('analyze-faces').click();
  await expect(page.locator('[role="alert"]')).toContainText('đồng ý');
  expect(calls).toHaveLength(0);

  await page.getByTestId('open-ai-settings').click();
  await page.getByTestId('ai-consent').check();
  await page.getByTestId('ai-close').click();
  await page.getByTestId('analyze-faces').click();
  await expect(page.getByTestId('face-summary')).toContainText('Mắt: nhắm', { timeout: 30_000 });
  expect(calls).toHaveLength(1);
});

test('the renderer never receives the token back', async () => {
  const view = await t.page.evaluate(() => window.eventstory.getAiSettings());
  expect(JSON.stringify(view)).not.toContain(TOKEN);
  expect(view).toMatchObject({ ok: true, value: { hasToken: true } });
});

test('settings survive a restart (token encrypted by the OS when available)', async () => {
  await t.close();
  t = await launchTestApp({ EVENTSTORY_USER_DATA: userData });
  const view = await t.page.evaluate(() => window.eventstory.getAiSettings());
  expect(view).toMatchObject({ ok: true, value: { endpoint: expect.stringContaining('127.0.0.1'), hasToken: true, tokenPersisted: true } });
  const quota = await t.page.evaluate(() => window.eventstory.getAiQuota());
  expect(quota).toMatchObject({ ok: true, value: { user: { used: 1 } } });
});
