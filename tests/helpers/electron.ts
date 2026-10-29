import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { makeTempDir, repoRoot } from './fs';
import type { Result } from '../../src/shared/contracts';

export interface TestApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

export async function launchTestApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const userData = extraEnv.EVENTSTORY_USER_DATA ?? (await makeTempDir('userdata'));
  const app = await electron.launch({
    ...(process.env.EVENTSTORY_TEST_APP ? { executablePath: process.env.EVENTSTORY_TEST_APP } : {}),
    args: process.env.EVENTSTORY_TEST_APP ? [] : [repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      EVENTSTORY_TEST: '1',
      EVENTSTORY_USER_DATA: userData,
      ...extraEnv,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    userData,
    close: () => app.close(),
  };
}

/** Replaces native folder dialogs in the main process with a queue of prepared answers. */
export async function stubOpenDialogs(app: ElectronApplication, answers: string[]): Promise<void> {
  await app.evaluate(({ dialog }, list) => {
    const queue = [...list];
    const fake = async () => {
      const next = queue.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    };
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, answers);
}

export async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, filePath);
}

/**
 * Opens a second window that is not an app window (data: URL) but still gets the
 * real preload, then calls the API from there. The main process must refuse it.
 */
export async function callFromInvalidSender(app: ElectronApplication): Promise<Result<void>> {
  const preload = path.join(repoRoot, 'out', 'preload', 'index.cjs');
  return app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL('data:text/html,<p>foreign</p>');
    const result = await win.webContents.executeJavaScript(
      'window.eventstory ? window.eventstory.cancelJob("j_00000000-0000-4000-8000-000000000000") : {ok:false,code:"NO_API"}',
    );
    win.destroy();
    return result;
  }, preload);
}
