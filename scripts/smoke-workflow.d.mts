import type { ElectronApplication, Page } from '@playwright/test';

export function listProcesses(): { pid: number; name: string; path: string; command: string }[];
export function helperProcesses(appRoot: string): { pid: number; path: string }[];
export function digestTree(dir: string): Promise<Record<string, string>>;
export function runWorkflow(opts: {
  electronApp: ElectronApplication;
  page: Page;
  relaunch: () => Promise<{ electronApp: ElectronApplication; page: Page }>;
  fixturesDir: string;
  workRoot: string;
  mark?: (k: string) => void;
}): Promise<{
  app: ElectronApplication;
  page: Page;
  projectId: string;
  logicalAssets: number;
  physicalFiles: number;
  statusCounts: Record<string, number>;
  savedDecisionIds: string[];
  openedProjectAfterRestart: { projectId: string; decisionIds: string[] };
  exportStatus: string;
  exportFolder: string;
  networkPhotoRequests: string[];
  peakWorkingSetMB: number;
  timings: Record<string, number>;
}>;
