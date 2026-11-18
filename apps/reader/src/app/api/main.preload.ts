import { contextBridge, ipcRenderer } from 'electron';
import type { RecoveryCandidate, RecoverySelection, Json, RecordValue } from '../storage/index.cjs';
import type { RecoveryStatus } from './storage-bridge';

contextBridge.exposeInMainWorld('reader', Object.freeze({
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('reader:version'),
  getStorageStatus: (): Promise<RecoveryStatus> =>
    ipcRenderer.invoke('reader:storageStatus'),
  load: (id: string): Promise<RecordValue | null> => ipcRenderer.invoke('reader:load', id),
  save: (id: string, data: Json, expectedRevision: number): Promise<RecordValue> =>
    ipcRenderer.invoke('reader:save', id, data, expectedRevision),
  listRecovery: (id: string): Promise<RecoveryCandidate[]> => ipcRenderer.invoke('reader:listRecovery', id),
  recover: (id: string, selection: RecoverySelection): Promise<RecordValue> =>
    ipcRenderer.invoke('reader:recover', id, selection),
}));
