import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestApp, stubOpenDialogs, type TestApp } from '../helpers/electron';
import { makeTempDir } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';

const N = 450;
let t: TestApp;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const base = await makeTempDir('e2e-biggroup');
  const card = path.join(base, 'card');
  const parent = path.join(base, 'projects');
  await mkdir(parent, { recursive: true });
  // No capture time: grouped by similarity alone, so one group can exceed the 200-item page size.
  for (let i = 0; i < N; i++) {
    await writeSyntheticJpeg(path.join(card, `G${String(i).padStart(3, '0')}.JPG`), { width: 96, height: 64, make: 'TEST', model: 'BIG', serial: '5', rgb: [90, 110, 130 + (i % 3)] });
  }
  t = await launchTestApp();
  await stubOpenDialogs(t.app, [parent, card]);
  await t.page.getByTestId('new-project-name').fill('Nhóm lớn');
  await t.page.getByTestId('create-project').click();
  await t.page.getByTestId('add-source').click();
  await expect(t.page.getByTestId('count-assets')).toHaveText(new RegExp(`^${N} ảnh`), { timeout: 240_000 });
  await t.page.getByTestId('scan-idle').waitFor({ timeout: 240_000 });
});

test.afterAll(async () => {
  await t?.close();
});

test('a group of 450 photos shows every member and its labels follow changes', async () => {
  const page = t.page;
  await page.getByTestId('mode-groups').click();
  const row = page.getByTestId('group-row').first();
  await expect(row).toContainText(`Cụm ${N} ảnh`);
  await expect(row.getByTestId('asset-cell')).toHaveCount(N, { timeout: 30_000 });
  await row.locator('[data-testid="asset-cell"][aria-label^="G449.JPG"]').click();
  await page.keyboard.press('k');
  await expect(row.locator('[data-testid="asset-cell"][aria-label^="G449.JPG"]')).toHaveAttribute('data-picked', 'true');
  await expect(row.getByTestId('group-picked')).toContainText('chọn 1');
});
