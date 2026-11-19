export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
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

export interface StorageBridge {
  getAppVersion(): Promise<string>;
  getStorageStatus(): Promise<RecoveryStatus>;
  load(id: string): Promise<RecordValue | null>;
  save(id: string, data: Json, expectedRevision: number): Promise<RecordValue>;
  listRecovery(id: string): Promise<RecoveryCandidate[]>;
  recover(id: string, selection: RecoverySelection): Promise<RecordValue>;
  libraryList(): Promise<BookSummary[]>;
  libraryImport(): Promise<Array<BookSummary | ImportFailure>>;
  libraryRemove(bookId: string, keepNotes: boolean): Promise<BookSummary>;
  libraryOpen(
    bookId: string,
  ): Promise<{ book: BookSummary; content: string | null }>;
  openBook(request: { bookId: string }): Promise<OpenedBook>;
  readChapter(request: { bookId: string; chapterId: string }): Promise<ReaderChapter>;
  saveReading(request: SaveReadingRequest): Promise<{ lastReadAt: string }>;
}
export interface BookSummary {
  bookId: string;
  contentHash: string;
  title: string;
  author: string;
  format: 'epub' | 'txt';
  fileStatus: 'available' | 'removed';
  importedAt: string;
  lastReadAt: string | null;
  chapters: { id: string; title: string }[];
  encoding: string | null;
}
export interface ReadingPosition {
  chapterId: string;
  blockIndex: number;
  /** UTF-16 code-unit offset into a text block, independent of screen layout. */
  offset: number;
}
export interface ReadingPreferences {
  mode: 'scroll' | 'paginated';
  fontSize: number;
  lineHeight: number;
  pageMargin: number;
  fontFamily: 'default' | 'serif' | 'sans-serif' | 'monospace';
  theme: 'light' | 'dark' | 'sepia';
}
export interface ReaderChapter { id: string; title: string; blocks: string[] }
export interface OpenedBook {
  book: BookSummary;
  position: ReadingPosition;
  preferences: ReadingPreferences;
}
export interface SaveReadingRequest {
  bookId: string;
  contentHash: string;
  position: ReadingPosition;
  preferences: ReadingPreferences;
}
export interface ImportFailure {
  error: string;
  fileName: string;
}
