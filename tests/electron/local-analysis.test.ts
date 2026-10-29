import { expect, test } from '@playwright/test';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestApp, stubOpenDialogs } from '../helpers/electron';
import { makeTempDir, repoRoot, sourceTreeDigest } from '../helpers/fs';

const model = process.env.EVENTSTORY_TEST_MODEL;
test('real MediaPipe model -> faces -> local AutoCull, without cloud credentials', async () => {
  test.skip(!model, 'Opt-in: EVENTSTORY_TEST_MODEL must point to the pinned external .task file.');
  test.setTimeout(240_000);
  const t = await launchTestApp();
  try {
    const base = await makeTempDir('local-ai-e2e');
    const parent = path.join(base, 'projects');
    const card = path.join(base, 'card');
    await mkdir(parent, { recursive: true });
    await mkdir(card);
    const fixture = path.join(repoRoot, 'tests/fixtures/files/arw/ACH07358.JPG');
    await copyFile(fixture, path.join(card, 'PHOTO.JPG'));
    await copyFile(fixture, path.join(card, 'COPY.JPG'));
    const before = await sourceTreeDigest(card);
    await stubOpenDialogs(t.app, [parent, card, model!]);
    await t.page.getByTestId('new-project-name').fill('Local MediaPipe');
    await t.page.getByTestId('create-project').click();
    await t.page.getByTestId('add-source').click();
    await expect(t.page.getByTestId('count-assets')).toHaveText(/^2 ảnh/, { timeout: 60_000 });
    await t.page.getByTestId('scan-idle').waitFor({ timeout: 60_000 });
    await t.page.getByTestId('select-local-model').click();
    await expect(t.page.getByTestId('start-local-autocull')).toBeEnabled({ timeout: 120_000 });
    const runner = t.app.windows().find((p) => p.url().includes('local-analysis.html'))!;
    expect(runner).toBeTruthy();
    const requests: string[] = [];
    runner.on('request', (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
    await t.page.getByTestId('start-local-autocull').click();
    await expect(t.page.getByTestId('autocull-status')).toContainText('Hoàn tất', { timeout: 120_000 });
    await t.page.getByTestId('list-keep').click();
    await expect(t.page.getByTestId('asset-cell')).toHaveCount(1);
    await t.page.getByTestId('asset-cell').first().click();
    await expect(t.page.getByTestId('face-summary')).toContainText('Mắt:');
    await expect(t.page.getByTestId('criterion-composition')).toBeVisible();
    expect(requests).toEqual([]);
    // This renderer has no privileged bridge and outbound network is blocked even if requested.
    expect(await runner.evaluate(() => typeof (window as unknown as { eventstory?: unknown }).eventstory)).toBe('undefined');
    expect(await runner.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } })).toBe(true);
    await t.page.getByTestId('start-local-autocull').click();
    await expect(t.page.getByTestId('autocull-status')).toContainText('Hoàn tất', { timeout: 60_000 });
    expect((await t.page.evaluate(() => window.eventstory.getAiSettings())).ok).toBe(true);
    expect(await sourceTreeDigest(card)).toBe(before);
  } finally { await t.close(); }
});
