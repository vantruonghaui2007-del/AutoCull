import { expect, test } from '@playwright/test';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestApp, stubOpenDialogs, type TestApp } from '../helpers/electron';
import { makeTempDir } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { colourCodedProvider, startLocalBackend } from '../helpers/local-backend';

// UI wiring of the v0.2 flow against the real backend logic running locally (provider replaced).
const TOKEN = 'ui-autocull-token-0123456789abcdef01234567';
const calls = { n: 0 };
let backend: Awaited<ReturnType<typeof startLocalBackend>>;
let t: TestApp;
let out: string;

test.beforeAll(async () => {
  backend = await startLocalBackend(colourCodedProvider(calls), TOKEN);
  const base = await makeTempDir('e2e-autocull');
  const card = path.join(base, 'card');
  const parent = path.join(base, 'projects');
  out = path.join(base, 'out');
  await mkdir(parent, { recursive: true });
  await mkdir(out, { recursive: true });
  const cam = { width: 640, height: 427, make: 'TEST', model: 'UI', serial: '1' };
  await writeSyntheticJpeg(path.join(card, 'B0.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:00', rgb: [70, 110, 150], squareAt: 300 });
  await writeSyntheticJpeg(path.join(card, 'B1.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:03', rgb: [150, 100, 70], squareAt: 302 });
  await writeSyntheticJpeg(path.join(card, 'B2.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:06', rgb: [70, 112, 152], squareAt: 304 });
  await writeSyntheticJpeg(path.join(card, 'S.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 11:00:00', rgb: [40, 160, 60] });
  t = await launchTestApp();
  await stubOpenDialogs(t.app, [parent, card, out]);
  await t.page.getByTestId('new-project-name').fill('AutoCull UI');
  await t.page.getByTestId('create-project').click();
  await t.page.getByTestId('add-source').click();
  await expect(t.page.getByTestId('count-assets')).toHaveText(/^4 ảnh/, { timeout: 60_000 });
  await t.page.getByTestId('scan-idle').waitFor({ timeout: 60_000 });
  await t.page.evaluate(
    async ([url, token]) => {
      await window.eventstory.saveAiSettings(url!, token!);
      await window.eventstory.setAiConsent(true);
    },
    [backend.url, TOKEN],
  );
});

test.afterAll(async () => {
  await t?.close();
  backend?.close();
});

test('AutoCull fills the three lists without any manual decision', async () => {
  const page = t.page;
  await expect(page.getByTestId('autocull-status')).toContainText('Chưa chạy');
  await page.getByTestId('start-autocull').click();
  await expect(page.getByTestId('autocull-status')).toContainText('Hoàn tất', { timeout: 60_000 });
  expect(calls.n).toBe(4);
  await expect(page.getByTestId('list-keep')).toContainText('(2)');
  await expect(page.getByTestId('list-better-option')).toContainText('(2)');
  await page.getByTestId('list-keep').click();
  await expect(page.getByTestId('asset-cell')).toHaveCount(2);
  for (const cell of await page.getByTestId('asset-cell').all()) await expect(cell).toHaveAttribute('data-cull-list', 'keep');
});

test('reasons and the five criteria explain a "better option"; manual choice wins and can be reset', async () => {
  const page = t.page;
  await page.getByTestId('list-better-option').click();
  await page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]').click();
  await expect(page.getByTestId('cull-panel')).toContainText('nhắm mắt');
  await expect(page.getByTestId('criterion-eyes')).toContainText('40');
  await expect(page.getByTestId('criterion-sharpness')).toBeVisible();
  await page.getByTestId('cull-keep').click();
  // B1 leaves this list (focus moves on to the next photo, as when culling) and joins the keep list.
  await expect(page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]')).toHaveCount(0);
  await page.getByTestId('list-keep').click();
  await expect(page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]')).toHaveAttribute('data-picked', 'true');
  await page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]').click();
  await expect(page.getByTestId('cull-panel')).toContainText('Giữ thủ công');
  await page.getByTestId('cull-auto').click();
  await expect(page.getByTestId('list-keep')).toContainText('(2)');
  await expect(page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]')).toHaveCount(0);
});

test('compare against the group pick shows face boxes with eye state', async () => {
  const page = t.page;
  await page.getByTestId('list-better-option').click();
  await page.locator('[data-testid="asset-cell"][aria-label^="B1.JPG"]').click();
  await page.getByTestId('compare-best').click();
  await expect(page.getByTestId('compare-pane')).toHaveCount(2);
  await expect(page.getByTestId('face-box').first()).toBeVisible();
  await expect(page.getByTestId('compare')).toContainText('nhắm');
  await page.keyboard.press('Escape');
});

test('packs and targets live in the legacy panel, collapsed by default', async () => {
  const page = t.page;
  await expect(page.getByTestId('pack-tab-quick')).toBeHidden();
  await page.getByTestId('legacy-panel').locator(':scope > summary').click();
  await expect(page.getByTestId('pack-tab-quick')).toBeVisible();
  await page.getByTestId('legacy-panel').locator(':scope > summary').click();
});

test('export copies the effective selection and verifies it', async () => {
  const page = t.page;
  await page.getByTestId('export-selection').click();
  await expect(page.getByTestId('export-dialog')).toContainText('Ảnh đã chọn');
  await page.getByTestId('choose-destination').click();
  await expect(page.getByTestId('export-preview')).toContainText('2 ảnh');
  await page.getByTestId('start-export').click();
  await expect(page.getByTestId('export-status')).toContainText('Hoàn tất', { timeout: 60_000 });
  const folder = (await readdir(out))[0]!;
  const files = (await readdir(path.join(out, folder))).filter((f) => f.endsWith('.JPG')).sort();
  expect(files).toHaveLength(2);
  expect(files).toContain('S.JPG');
});
