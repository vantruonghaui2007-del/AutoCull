import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchTestApp } from '../helpers/electron';
import { fixturesRoot, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, workRoot } from '../helpers/fs';

// The same end-to-end workflow that `npm run test:installed -- --workflow` runs against a packaged
// build, here against the development build. Produces the same report shape.
test('end-to-end workflow report: scan, review, export, restart, cleanup', async () => {
  test.setTimeout(600_000);
  await requireVerifiedFixtures();
  const wf = (await import('../../scripts/smoke-workflow.mjs')) as typeof import('../../scripts/smoke-workflow.mjs');
  const userData = await makeTempDir('wf-userdata');
  const launch = async () => {
    const t = await launchTestApp({ EVENTSTORY_USER_DATA: userData });
    return { electronApp: t.app, page: t.page };
  };
  const before = await wf.digestTree(fixturesRoot);
  const first = await launch();
  const status = await first.page.evaluate(() => window.eventstory.getAppStatus());
  const workflow = await wf.runWorkflow({ ...first, relaunch: launch, fixturesDir: fixturesRoot, workRoot: path.join(workRoot), mark: () => {} });
  await workflow.app.close();
  await new Promise((r) => setTimeout(r, 2000));
  const report = {
    helperVersion: status.ok ? status.value.exiftoolVersion : null,
    rawSourceDigestsBefore: before,
    rawSourceDigestsAfter: await wf.digestTree(fixturesRoot),
    openedProjectAfterRestart: workflow.openedProjectAfterRestart,
    networkPhotoRequests: workflow.networkPhotoRequests,
    remainingChildProcesses: wf.helperProcesses(path.resolve(__dirname, '..', '..')),
    exportStatus: workflow.exportStatus,
  };
  const savedDecisionIds = workflow.savedDecisionIds;

  expect(report.helperVersion).toMatch(/\d+\.\d+/);
  expect(report.rawSourceDigestsAfter).toEqual(report.rawSourceDigestsBefore);
  expect(savedDecisionIds.length).toBeGreaterThan(0);
  expect(report.openedProjectAfterRestart.decisionIds).toEqual(savedDecisionIds);
  expect(report.networkPhotoRequests).toEqual([]);
  expect(report.remainingChildProcesses).toEqual([]);
  expect(report.exportStatus).toBe('verified');
  expect(workflow.statusCounts.queued ?? 0).toBe(0);
  expect(workflow.statusCounts['no-preview']).toBe(1); // the truncated ARW fixture
});
