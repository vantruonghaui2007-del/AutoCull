#!/usr/bin/env node
// Smoke test for a packaged/installed EventStory Cull build.
// Usage: node scripts/smoke-installed.mjs --app <exe|.app|folder> [--fixtures <dir>] [--out <dir>] [--workflow] [--skip-digest]
// Runs the app's own bundled helper (never one from PATH), records OS/arch/versions/timings,
// optionally runs the scan/review/export/restart workflow on the fixtures, and verifies that no
// helper process outlives the app and the sources are byte-identical. Writes a JSON report and
// exits non-zero on failure.
import { _electron as electron } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digestTree, helperProcesses, runWorkflow } from './smoke-workflow.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const repoRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.resolve(repoRoot, '..', 'work');
const appArg = opt('app');
const fixturesDir = opt('fixtures') ? path.resolve(opt('fixtures')) : null;
const outDir = path.resolve(opt('out', path.join(workRoot, 'smoke')));
if (!appArg) {
  console.error('Thiếu --app <đường-dẫn-app-đã-đóng-gói>');
  process.exit(2);
}

function resolveApp(p) {
  const abs = path.resolve(p);
  if (process.platform === 'darwin') {
    const app = abs.endsWith('.app') ? abs : readdirSync(abs).map((n) => path.join(abs, n)).find((n) => n.endsWith('.app'));
    if (!app) throw new Error(`Không tìm thấy .app trong ${abs}`);
    const macos = path.join(app, 'Contents', 'MacOS');
    return { exe: path.join(macos, readdirSync(macos)[0]), resources: path.join(app, 'Contents', 'Resources'), root: app };
  }
  if (statSync(abs).isFile()) return { exe: abs, resources: path.join(path.dirname(abs), 'resources'), root: path.dirname(abs) };
  const exe = readdirSync(abs).find((n) => n.toLowerCase() === 'eventstory cull.exe' || n === 'eventstory-cull');
  if (!exe) throw new Error(`Không tìm thấy file chạy trong ${abs}`);
  return { exe: path.join(abs, exe), resources: path.join(abs, 'resources'), root: abs };
}

const report = {
  startedAt: new Date().toISOString(),
  os: `${process.platform} ${os.release()}`,
  arch: process.arch,
  totalMemoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  cpus: os.cpus().length,
  app: null,
  appVersion: null,
  electronVersion: null,
  helperVersion: null,
  resources: null,
  helperPathsDuringRun: [],
  helperPackaged: null,
  sharpPackaged: null,
  fixtures: fixturesDir,
  workflow: null,
  exportStatus: null,
  savedDecisionIds: null,
  openedProjectAfterRestart: null,
  rawSourceDigestsBefore: null,
  rawSourceDigestsAfter: null,
  networkPhotoRequests: [],
  remainingChildProcesses: [],
  timings: {},
  exitStatus: 'unknown',
  errors: [],
};

const t0 = Date.now();
const mark = (k) => (report.timings[k] = Date.now() - t0);
let electronApp = null;
try {
  const app = resolveApp(appArg);
  report.app = app.exe;
  const unpacked = path.join(app.resources, 'app.asar.unpacked', 'node_modules');
  const helperDir = path.join(unpacked, process.platform === 'win32' ? 'exiftool-vendored.exe' : 'exiftool-vendored.pl');
  report.helperPackaged = existsSync(helperDir);
  report.sharpPackaged = existsSync(path.join(unpacked, 'sharp')) && existsSync(path.join(unpacked, '@img'));
  if (!report.helperPackaged) throw new Error(`Thiếu ExifTool trong bản đóng gói: ${helperDir}`);
  // v0.2: LibRaw helper, its CDDL source/notices, and the app icon ship with the build.
  const rawExe = path.join(app.resources, 'bin', process.platform === 'win32' ? 'eventstory-raw.exe' : 'eventstory-raw');
  report.librawHelper = existsSync(rawExe) ? JSON.parse(execFileSync(rawExe, ['--version'], { encoding: 'utf8', windowsHide: true })).libraw : null;
  const tarball = path.join(app.resources, 'licenses', 'LibRaw', 'LibRaw-0.22.3.tar.gz');
  report.librawSourceSha256 = existsSync(tarball) ? createHash('sha256').update(readFileSync(tarball)).digest('hex') : null;
  report.librawNotices = ['COPYRIGHT', 'LICENSE.CDDL', 'BUILD.md'].every((n) => existsSync(path.join(app.resources, 'licenses', 'LibRaw', n)));
  report.iconPackaged = existsSync(path.join(app.resources, 'icon.png'));
  if (!report.librawHelper?.startsWith('0.22.3')) throw new Error(`LibRaw helper thiếu hoặc sai phiên bản: ${report.librawHelper}`);
  if (report.librawSourceSha256 !== '789f3c33466210a1a0907f747a97c715d21bbf4af712f257fcbbd90111b227e4') throw new Error('Thiếu hoặc sai mã nguồn LibRaw đi kèm');
  if (!report.librawNotices) throw new Error('Thiếu thông báo giấy phép LibRaw');
  if (fixturesDir) {
    const arw = path.join(fixturesDir, 'arw', 'ACH07358.ARW');
    if (existsSync(arw)) {
      const r = spawnSync(rawExe, [arw], { windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
      const head = JSON.parse(r.stdout.subarray(0, r.stdout.indexOf(10)).toString('utf8'));
      report.librawDecode = { exit: r.status, width: head.width, height: head.height, bytes: r.stdout.length };
      if (r.status !== 0 || !head.ok) throw new Error('Helper LibRaw đóng gói không giải mã được ARW mẫu');
    }
  }
  if (!report.sharpPackaged) throw new Error('Thiếu Sharp/@img trong app.asar.unpacked');

  await mkdir(workRoot, { recursive: true });
  const userData = await mkdtemp(path.join(workRoot, 'smoke-userdata-'));
  const digest = fixturesDir && !flag('skip-digest');
  if (digest) report.rawSourceDigestsBefore = await digestTree(fixturesDir);

  const launch = async () => {
    const a = await electron.launch({ executablePath: app.exe, env: { ...process.env, EVENTSTORY_TEST: '1', EVENTSTORY_USER_DATA: userData } });
    const p = await a.firstWindow();
    p.on('request', (r) => {
      if (/^(https?|wss?):/i.test(r.url())) report.networkPhotoRequests.push(r.url());
    });
    await p.waitForLoadState('domcontentloaded');
    return { electronApp: a, page: p };
  };
  const first = await launch();
  electronApp = first.electronApp;
  mark('windowReady');
  const status = await first.page.evaluate(() => window.eventstory.getAppStatus());
  mark('statusReady');
  if (!status.ok) throw new Error(`getAppStatus: ${status.code} ${status.message}`);
  report.appVersion = status.value.appVersion;
  report.electronVersion = status.value.electronVersion;
  report.helperVersion = status.value.exiftoolVersion;
  report.resources = status.value.resources;
  report.helperPathsDuringRun = helperProcesses(app.root).map((p) => p.path);
  if (!report.helperVersion) throw new Error('ExifTool không chạy được từ bản đóng gói');
  if (report.helperPathsDuringRun.length === 0) throw new Error('Không thấy tiến trình ExifTool chạy từ thư mục ứng dụng');

  if (flag('workflow')) {
    if (!fixturesDir) throw new Error('--workflow cần --fixtures');
    const wf = await runWorkflow({ electronApp, page: first.page, relaunch: launch, fixturesDir, workRoot, mark });
    electronApp = wf.app;
    const { app: _a, page: _p, ...rest } = wf;
    report.workflow = rest;
    report.exportStatus = wf.exportStatus;
    report.autocullStatus = wf.autocullStatus;
    report.savedDecisionIds = wf.savedDecisionIds;
    report.openedProjectAfterRestart = wf.openedProjectAfterRestart;
    report.networkPhotoRequests.push(...wf.networkPhotoRequests);
  }

  await electronApp.close();
  electronApp = null;
  mark('closed');
  await new Promise((r) => setTimeout(r, 2000));
  report.remainingChildProcesses = helperProcesses(app.root);
  if (digest) report.rawSourceDigestsAfter = await digestTree(fixturesDir);
  report.networkPhotoRequests = [...new Set(report.networkPhotoRequests)];

  if (digest && JSON.stringify(report.rawSourceDigestsBefore) !== JSON.stringify(report.rawSourceDigestsAfter)) report.errors.push('Nguồn bị thay đổi sau khi chạy');
  if (report.remainingChildProcesses.length) report.errors.push('Còn tiến trình ExifTool sau khi thoát');
  if (report.networkPhotoRequests.length) report.errors.push('Có request mạng từ renderer');
  if (flag('workflow')) {
    if (report.exportStatus !== 'verified') report.errors.push(`Xuất chưa xác minh: ${report.exportStatus}`);
    if (JSON.stringify(report.savedDecisionIds) !== JSON.stringify(report.openedProjectAfterRestart?.decisionIds)) report.errors.push('Quyết định không khớp sau khi mở lại');
    if (!report.savedDecisionIds?.length) report.errors.push('Workflow không ghi được quyết định nào');
  }
  report.exitStatus = report.errors.length ? 'failed' : 'passed';
} catch (e) {
  report.errors.push(String(e?.stack ?? e));
  report.exitStatus = 'failed';
  if (electronApp) await electronApp.close().catch(() => {});
}

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `smoke-${process.platform}-${process.arch}-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      exitStatus: report.exitStatus,
      helperVersion: report.helperVersion,
      exportStatus: report.exportStatus,
      autocullStatus: report.autocullStatus,
      librawHelper: report.librawHelper,
      librawDecode: report.librawDecode,
      peakWorkingSetMB: report.workflow?.peakWorkingSetMB,
      timings: report.workflow?.timings,
      report: file,
      errors: report.errors,
    },
    null,
    2,
  ),
);
process.exit(report.exitStatus === 'passed' ? 0 : 1);
