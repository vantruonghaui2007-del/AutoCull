// Shared end-to-end workflow and helpers for tests/electron/workflow.test.ts (dev build)
// and scripts/smoke-installed.mjs (packaged build).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

export function listProcesses() {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(out).map((p) => ({ pid: p.ProcessId, name: p.Name ?? '', path: p.ExecutablePath ?? '', command: p.CommandLine ?? '' }));
  }
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return { pid: Number(m[1]), name: '', path: '', command: m[2] };
    });
}

const norm = (s) => s.toLowerCase().replaceAll('\\', '/');

/** ExifTool (or its bundled perl) processes started from inside `appRoot`. */
export function helperProcesses(appRoot) {
  const root = norm(appRoot);
  return listProcesses()
    .filter((p) => {
      const hay = norm(`${p.path} ${p.command}`);
      return hay.includes(root) && hay.includes('exiftool');
    })
    .map((p) => ({ pid: p.pid, path: p.path || p.command }));
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Relative path -> full SHA-256 for every file under `dir` (links are not followed). */
export async function digestTree(dir) {
  const files = {};
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files[r] = path.join(d, e.name);
    }
  };
  walk(dir);
  const out = {};
  for (const k of Object.keys(files).sort()) out[k] = await sha256(files[k]);
  return out;
}

async function stubOpenDialogs(app, answers) {
  await app.evaluate(({ dialog }, list) => {
    const queue = [...list];
    dialog.showOpenDialog = async () => {
      const next = queue.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    };
  }, answers);
}

async function memorySample(app) {
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.memory.workingSetSize));
  return metrics.reduce((s, kb) => s + kb, 0) / 1024;
}

/**
 * Create a project, scan `fixturesDir`, confirm RAW+JPEG pairs, review with the keyboard, run AutoCull,
 * export the effective selection with verification, restart the app and read the decisions back.
 */
export async function runWorkflow({ electronApp, page, relaunch, fixturesDir, workRoot, mark }) {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, 'workflow-'));
  const projectParent = path.join(base, 'projects');
  const dest = path.join(base, 'export');
  await mkdir(projectParent);
  await mkdir(dest);
  const networkPhotoRequests = [];
  const watch = (pg) =>
    pg.on('request', (r) => {
      if (/^(https?|wss?):/i.test(r.url())) networkPhotoRequests.push(r.url());
    });
  watch(page);
  const t0 = Date.now();
  const timings = {};
  const at = (k) => {
    timings[k] = Date.now() - t0;
    mark?.(k);
  };

  await stubOpenDialogs(electronApp, [projectParent, fixturesDir]);
  await page.getByTestId('new-project-name').fill(`Workflow ${new Date().toISOString().slice(0, 19)}`);
  await page.getByTestId('create-project').click();
  await page.getByTestId('add-source').click();
  at('scanStarted');
  let peakWorkingSetMB = await memorySample(electronApp);
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peakWorkingSetMB = Math.max(peakWorkingSetMB, await memorySample(electronApp).catch(() => 0));
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await page.locator('[data-testid="asset-cell"] img').first().waitFor({ timeout: 600_000 });
  at('firstPreview');
  await page.getByTestId('scan-progress').waitFor({ timeout: 5_000 }).catch(() => {});
  await page.getByTestId('scan-idle').waitFor({ timeout: 3_600_000 });
  sampling = false;
  await sampler;
  at('scanComplete');

  if ((await page.getByTestId('confirm-pairs').count()) > 0) {
    await page.getByTestId('confirm-pairs').click();
    await page.waitForTimeout(1000);
  }

  const cells = page.getByTestId('asset-cell');
  await cells.first().click();
  for (const k of ['k', '4', 'ArrowRight', 'k', '5', 'ArrowRight', 'x']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);

  const snap = await page.evaluate(() => window.eventstory.restoreLastProject());
  if (!snap.ok || !snap.value) throw new Error('Không lấy được dự án đang mở');
  const projectId = snap.value.id;
  const keepIds = async (pg) => {
    const r = await pg.evaluate((id) => window.eventstory.queryAssets(id, { offset: 0, limit: 200, state: 'keep' }), projectId);
    if (!r.ok) throw new Error(r.message);
    return r.value.items.map((a) => a.id).sort();
  };
  const savedDecisionIds = await keepIds(page);
  const state = await page.evaluate((id) => window.eventstory.getProjectState(id), projectId);
  const statusCounts = state.ok ? state.value.snapshot.counts : {};
  const logicalAssets = state.ok ? state.value.logicalAssets : 0;
  const physicalFiles = state.ok ? state.value.physicalFiles : 0;

  // v0.2: AutoCull over the whole album (without AI settings it groups/ranks and pauses honestly),
  // then export the effective selection (manual keeps win).
  await page.getByTestId('start-autocull').click();
  await page.getByTestId('autocull-status').filter({ hasText: /Hoàn tất|tạm dừng|lỗi|đã hủy/ }).waitFor({ timeout: 3_600_000 });
  const autocullStatus = await page.getByTestId('autocull-status').innerText();
  at('autocull');

  await stubOpenDialogs(electronApp, [dest]);
  await page.getByTestId('export-selection').click();
  await page.getByTestId('choose-destination').click();
  await page.getByTestId('start-export').click();
  const statusText = await page.getByTestId('export-status').innerText({ timeout: 600_000 });
  const exportStatus = statusText.startsWith('Hoàn tất') ? 'verified' : statusText;
  at('exported');

  await electronApp.close();
  const next = await relaunch();
  watch(next.page);
  await next.page.getByTestId('count-assets').waitFor({ timeout: 120_000 });
  at('restarted');
  const openedProjectAfterRestart = { projectId, decisionIds: await keepIds(next.page) };

  return {
    app: next.electronApp,
    page: next.page,
    projectId,
    logicalAssets,
    physicalFiles,
    statusCounts,
    savedDecisionIds,
    openedProjectAfterRestart,
    exportStatus,
    autocullStatus,
    exportFolder: dest,
    networkPhotoRequests,
    peakWorkingSetMB: Math.round(peakWorkingSetMB),
    timings,
  };
}
