import type { RecoveryCandidate, RecoveryStatus, RecoverySelection, RecordValue, Json } from '../storage/index.cjs';

export type { RecoveryStatus } from '../storage/index.cjs';

export interface StorageBridge {
  getAppVersion(): Promise<string>;
  getStorageStatus(): Promise<RecoveryStatus>;
  load(id: string): Promise<RecordValue | null>;
  save(id: string, data: Json, expectedRevision: number): Promise<RecordValue>;
  listRecovery(id: string): Promise<RecoveryCandidate[]>;
  recover(id: string, selection: RecoverySelection): Promise<RecordValue>;
}

declare global {
  interface Window {
    reader?: StorageBridge;
  }
}
