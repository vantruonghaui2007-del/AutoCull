import { expect, test } from '@playwright/test';
import { callFromInvalidSender, launchTestApp, type TestApp } from '../helpers/electron';

let t: TestApp;

test.beforeAll(async () => {
  t = await launchTestApp();
});

test.afterAll(async () => {
  await t?.close();
});

test('main window uses isolated, sandboxed renderer settings', async () => {
  const actualWebPreferences = await t.app.evaluate(({ BrowserWindow }) => {
    const prefs = (BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences();
    return { nodeIntegration: prefs?.nodeIntegration, contextIsolation: prefs?.contextIsolation, sandbox: prefs?.sandbox };
  });
  expect(actualWebPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
});

test('the packaged renderer is served and shows the app', async () => {
  await expect(t.page.getByTestId('worker-status')).toContainText('Bộ xử lý', { timeout: 15_000 });
});

test('renderer has no Node access', async () => {
  expect(await t.page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  expect(await t.page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined');
});

test('preload exposes only the narrow API, without raw ipcRenderer', async () => {
  const keys = await t.page.evaluate(() => Object.keys((window as unknown as { eventstory: object }).eventstory).sort());
  expect(keys).toContain('createProject');
  expect(keys).toContain('onProgress');
  expect(keys).not.toContain('invoke');
  expect(keys).not.toContain('ipcRenderer');
});

test('calls from a non-app frame are refused', async () => {
  expect(await callFromInvalidSender(t.app)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
});

test('window receives internal status from the worker', async () => {
  const status = await t.page.evaluate(() =>
    (window as unknown as { eventstory: { getAppStatus(): Promise<unknown> } }).eventstory.getAppStatus(),
  );
  expect(status).toMatchObject({ ok: true, value: { worker: 'ready' } });
});

test('malformed command payloads from the app window are rejected by validation', async () => {
  const r = await t.page.evaluate(() =>
    (window as unknown as { eventstory: { applyCommand(p: string, c: unknown): Promise<unknown> } }).eventstory.applyCommand(
      '..\\..\\etc',
      { type: 'set-rating', assetIds: ['C:\\Windows\\win.ini'], rating: 9 },
    ),
  );
  expect(r).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
});

test('navigation to an external site is blocked', async () => {
  const url = await t.app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    await wc.executeJavaScript('location.href = "https://example.com/"; 1').catch(() => 0);
    await new Promise((r) => setTimeout(r, 500));
    return wc.getURL();
  });
  expect(url.startsWith('app://')).toBe(true);
});

test('worker runs in a separate utility process', async () => {
  const pids = await t.app.evaluate(({ app }) =>
    app.getAppMetrics().filter((m) => m.type === 'Utility' && m.name === 'eventstory-worker').map((m) => m.pid),
  );
  expect(pids.length).toBe(1);
});
