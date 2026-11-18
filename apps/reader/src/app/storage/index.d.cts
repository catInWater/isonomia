export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RecordValue<T extends Json = Json> {
  id: string;
  revision: number;
  schemaVersion: number;
  data: T;
}
export interface RecoveryCandidate {
  name: string;
  valid: boolean;
  revision?: number;
  schemaVersion?: number;
  checksum?: string;
  error?: string;
}
export interface RecoverySelection {
  name: string;
  checksum: string;
  expectedRevision: number;
}
export interface RecoveryStatus {
  available: boolean;
  message: string;
  recovery: RecoveryCandidate[];
  expectedRevision: number;
}
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
    migrations?: { [sourceVersion: number]: (data: Json) => Json | Promise<Json> };
    checkpoint?: (stage: string, details: { [key: string]: unknown }) => Promise<void>;
  });
  load(id: string): Promise<RecordValue | null>;
  save(id: string, data: Json, expectedRevision: number): Promise<RecordValue>;
  migrate(id: string): Promise<RecordValue | null>;
  listRecovery(id: string): Promise<RecoveryCandidate[]>;
  recover(id: string, selection: RecoverySelection): Promise<RecordValue>;
}
