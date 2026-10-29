import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { EventStoryApi, ProgressEvent } from '../shared/contracts';

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`es:${name}`, ...args);

const api: EventStoryApi = {
  getAppStatus: call('getAppStatus') as EventStoryApi['getAppStatus'],
  createProject: call('createProject') as EventStoryApi['createProject'],
  openProject: call('openProject') as EventStoryApi['openProject'],
  restoreLastProject: call('restoreLastProject') as EventStoryApi['restoreLastProject'],
  closeProject: call('closeProject') as EventStoryApi['closeProject'],
  getProjectState: call('getProjectState') as EventStoryApi['getProjectState'],
  chooseSources: call('chooseSources') as EventStoryApi['chooseSources'],
  relinkSource: call('relinkSource') as EventStoryApi['relinkSource'],
  cancelJob: call('cancelJob') as EventStoryApi['cancelJob'],
  queryAssets: call('queryAssets') as EventStoryApi['queryAssets'],
  listGroups: call('listGroups') as EventStoryApi['listGroups'],
  listPairCandidates: call('listPairCandidates') as EventStoryApi['listPairCandidates'],
  applyCommand: call('applyCommand') as EventStoryApi['applyCommand'],
  suggestPack: call('suggestPack') as EventStoryApi['suggestPack'],
  listDeliveries: call('listDeliveries') as EventStoryApi['listDeliveries'],
  previewExport: call('previewExport') as EventStoryApi['previewExport'],
  confirmExport: call('confirmExport') as EventStoryApi['confirmExport'],
  getExportReport: call('getExportReport') as EventStoryApi['getExportReport'],
  openExportFolder: call('openExportFolder') as EventStoryApi['openExportFolder'],
  exportPortable: call('exportPortable') as EventStoryApi['exportPortable'],
  importPortable: call('importPortable') as EventStoryApi['importPortable'],
  getAiSettings: call('getAiSettings') as EventStoryApi['getAiSettings'],
  saveAiSettings: call('saveAiSettings') as EventStoryApi['saveAiSettings'],
  setAiConsent: call('setAiConsent') as EventStoryApi['setAiConsent'],
  getAiQuota: call('getAiQuota') as EventStoryApi['getAiQuota'],
  analyzeFaces: call('analyzeFaces') as EventStoryApi['analyzeFaces'],
  startAutoCull: call('startAutoCull') as EventStoryApi['startAutoCull'],
  getLocalAnalysisSettings: call('getLocalAnalysisSettings') as EventStoryApi['getLocalAnalysisSettings'],
  selectLocalModel: call('selectLocalModel') as EventStoryApi['selectLocalModel'],
  getCullState: call('getCullState') as EventStoryApi['getCullState'],
  onProgress(listener) {
    const wrapped = (_e: IpcRendererEvent, event: ProgressEvent) => listener(event);
    ipcRenderer.on('es:progress', wrapped);
    return () => {
      ipcRenderer.removeListener('es:progress', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('eventstory', api);
