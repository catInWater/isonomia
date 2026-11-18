import type {
  Json,
  RecordValue,
  RecoveryCandidate,
  RecoverySelection,
} from '@reader/storage-bridge';
export type {
  Json,
  RecordValue,
  RecoveryCandidate,
  RecoverySelection,
  RecoveryStatus,
} from '@reader/storage-bridge';

export class StorageError extends Error {
  code: string;
  details: { [key: string]: unknown };
}
export function validateId(id: string): string;
/** Private main-process root. Own with Electron's single-instance lock.
 * Validators must return true. Migrations keyed by source version produce version + 1.
 * Fulfilled writes are flushed; rejected writes may have committed: reload before retry.
 * Retains all revisions and snapshots. No debouncing: caller owns input-save scheduling.
 */
export class DurableStore {
  constructor(options: {
    root: string;
    schemaVersion: number;
    schemas: { [version: number]: (data: Json) => boolean };
    migrations?: {
      [sourceVersion: number]: (data: Json) => Json | Promise<Json>;
    };
    checkpoint?: (
      stage: string,
      details: { [key: string]: unknown },
    ) => Promise<void>;
  });
  load(id: string): Promise<RecordValue | null>;
  save(id: string, data: Json, expectedRevision: number): Promise<RecordValue>;
  migrate(id: string): Promise<RecordValue | null>;
  listRecovery(id: string): Promise<RecoveryCandidate[]>;
  recover(id: string, selection: RecoverySelection): Promise<RecordValue>;
}
