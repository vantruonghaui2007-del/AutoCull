import { expect, test, type Page } from '@playwright/test';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestApp, stubOpenDialogs, type TestApp } from '../helpers/electron';
import { fixturePath, loadFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let t: TestApp;
let userData: string;
let card: string;
let projectParent: string;

async function visibleCounter(page: Page, unit: 'ảnh' | 'tệp gốc'): Promise<number> {
  const text = await page.getByTestId(unit === 'ảnh' ? 'count-assets' : 'count-files').innerText();
  expect(text).toContain(unit);
  return Number(text.replace(/\D+/g, ''));
}

test.beforeAll(async () => {
  const base = await makeTempDir('e2e-review');
  card = path.join(base, 'Thẻ nhớ');
  projectParent = path.join(base, 'Dự án');
  userData = path.join(base, 'userdata');
  await mkdir(path.join(card, 'DCIM'), { recursive: true });
  await mkdir(projectParent, { recursive: true });
  for (const [id, name] of [
    ['arw-sony-a7c-1', 'ACH07358.ARW'],
    ['jpeg-sony-a7c-1', 'ACH07358.JPG'],
    ['arw-sony-a7c-2', 'ACH07359.ARW'],
    ['jpeg-sony-a7c-2', 'ACH07359.JPG'],
    ['arw-sony-a7c-portrait', 'ACH07383.ARW'],
    ['jpeg-sony-a7c-portrait', 'ACH07383.JPG'],
    ['jpeg-no-exif', 'khong-exif.jpg'],
  ] as const) {
    await copyFile(fx(id), path.join(card, 'DCIM', name));
  }
  t = await launchTestApp({ EVENTSTORY_USER_DATA: userData });
});

test.afterAll(async () => {
  await t?.close();
});

test('create a project, scan, pair, review with the keyboard and undo', async () => {
  const page = t.page;
  await stubOpenDialogs(t.app, [projectParent, card]);
  await page.getByTestId('new-project-name').fill('Hội thảo');
  await page.getByTestId('create-project').click();
  await page.getByTestId('add-source').click();
  await expect(page.getByTestId('count-assets')).toHaveText(/^7 ảnh/, { timeout: 90_000 });
  await expect(page.getByTestId('scan-idle')).toBeVisible({ timeout: 90_000 });
  expect(await visibleCounter(page, 'ảnh')).toBe(7);
  expect(await visibleCounter(page, 'tệp gốc')).toBe(7);

  await page.getByTestId('confirm-pairs').click();
  await expect(page.getByTestId('count-assets')).toHaveText(/^4 ảnh/);
  const logicalAssetCount = 4;
  const physicalFileCount = 7;
  expect(await visibleCounter(page, 'ảnh')).toBe(logicalAssetCount);
  expect(await visibleCounter(page, 'tệp gốc')).toBe(physicalFileCount);

  const first = page.getByTestId('asset-cell').first();
  await first.click();
  await page.keyboard.press('3');
  await expect(page.getByTestId('rating-value')).toHaveText('3');
  const originalRating = await page.getByTestId('rating-value').innerText();

  await page.getByTestId('search').fill('5');
  await page.getByTestId('search').fill('');
  await first.click();
  const ratingAfterTypingInSearch = await page.getByTestId('rating-value').innerText();
  expect(ratingAfterTypingInSearch).toBe(originalRating);

  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('rating-value')).toHaveText('0');
  await page.keyboard.press('k');
  await expect(page.getByTestId('review-state')).toHaveText('Giữ');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await expect(page.getByTestId('review-state')).toHaveText('Bỏ qua');
  await expect(page.getByTestId('asset-cell').first()).toHaveAttribute('data-state', 'keep');
});

test('compare view syncs zoom and warns past preview resolution', async () => {
  const page = t.page;
  await page.getByTestId('asset-cell').nth(0).click();
  await page.keyboard.press('c');
  await expect(page.getByTestId('compare')).toBeVisible();
  await expect(page.getByTestId('compare-pane')).toHaveCount(2);
  for (let i = 0; i < 6; i++) await page.getByTestId('zoom-in').click();
  const scales = await page.getByTestId('compare-pane').evaluateAll((els) => els.map((e) => e.getAttribute('data-zoom')));
  expect(new Set(scales).size).toBe(1);
  await expect(page.getByTestId('zoom-warning')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compare')).toHaveCount(0);
});

test('packs: add a target, see coverage, suggest, accept and record a delivery', async () => {
  const page = t.page;
  // v0.2: packs and targets moved to the legacy panel.
  await page.getByTestId('legacy-panel').locator(':scope > summary').click();
  await page.locator('.targets-editor summary').click();
  await page.getByTestId('target-label').fill('Diễn giả');
  await page.getByTestId('add-target').click();
  const box = page.locator('.packpanel .row label', { hasText: 'Diễn giả' }).locator('input');
  await box.click();
  await expect(box).toBeChecked();
  await expect(page.getByTestId('coverage')).toContainText('Diễn giả: Thiếu');
  await page.getByTestId('suggest').click();
  await expect(page.getByTestId('suggestion')).toContainText('Thiếu ảnh đã duyệt cho mục tiêu bắt buộc "Diễn giả"');
  await page.getByTestId('accept-suggestion').click();
  await expect(page.getByTestId('pack-tab-quick')).toHaveText(/Trả nhanh \(1\)/);
  await page.getByTestId('mark-delivered').click();
  await page.getByTestId('confirm-delivery').click();
  await expect(page.locator('.history li')).toHaveCount(1);
});

test('export: preview then copy verified originals into a new folder', async () => {
  const page = t.page;
  const dest = path.join(path.dirname(card), 'Giao khách');
  await mkdir(dest, { recursive: true });
  await stubOpenDialogs(t.app, [dest]);
  await page.getByTestId('open-export').click();
  await page.getByTestId('choose-destination').click();
  await expect(page.getByTestId('export-preview')).toContainText('1 ảnh');
  await page.getByTestId('start-export').click();
  await expect(page.getByTestId('export-status')).toHaveText('Hoàn tất, mọi tệp đã kiểm tra khớp', { timeout: 60_000 });
  const folders = await readdir(dest);
  expect(folders.filter((f) => f.startsWith('EventStory_TraNhanh_'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Đóng' }).last().click();
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
});

test('export: a manifest-only export that finishes instantly still shows its report', async () => {
  const page = t.page;
  for (let i = 0; i < 3; i++) {
    const dest = path.join(path.dirname(card), `Manifest ${i}`);
    await mkdir(dest, { recursive: true });
    await stubOpenDialogs(t.app, [dest]);
    await page.getByTestId('open-export').click();
    await page.getByTestId('mode-manifest').check();
    await page.getByTestId('choose-destination').click();
    await page.getByTestId('start-export').click();
    await expect(page.getByTestId('export-status')).toHaveText('Hoàn tất, mọi tệp đã kiểm tra khớp', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Đóng' }).last().click();
  }
});

test('shortcuts do not change decisions while a dialog is open', async () => {
  const page = t.page;
  await page.getByTestId('asset-cell').first().click();
  const before = await page.getByTestId('rating-value').innerText();
  await page.getByTestId('open-export').click();
  await page.keyboard.press(before === '2' ? '3' : '2');
  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Đóng' }).last().click();
  await expect(page.getByTestId('rating-value')).toHaveText(before);
});

test('the session is restored after closing and reopening the app', async () => {
  await t.close();
  t = await launchTestApp({ EVENTSTORY_USER_DATA: userData });
  await expect(t.page.getByTestId('count-assets')).toHaveText(/^4 ảnh/, { timeout: 30_000 });
  await expect(t.page.getByTestId('asset-cell').first()).toHaveAttribute('data-state', 'keep');
});
