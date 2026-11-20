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
  libraryCover(bookId: string): Promise<string | null>;
  libraryImport(): Promise<Array<BookSummary | ImportFailure>>;
  libraryRemove(bookId: string, keepNotes: boolean): Promise<BookSummary>;
  libraryOpen(
    bookId: string,
  ): Promise<{ book: BookSummary; content: string | null }>;
  openBook(request: { bookId: string }): Promise<OpenedBook>;
  readChapter(request: {
    bookId: string;
    chapterId: string;
  }): Promise<ReaderChapter>;
  saveReading(request: SaveReadingRequest): Promise<{ lastReadAt: string }>;
  libraryReplace(bookId: string): Promise<BookSummary | null>;
  listAnnotations(request: { bookId: string }): Promise<AnnotationSnapshot>;
  changeAnnotation(request: AnnotationRequest): Promise<AnnotationSnapshot>;
  copyAnnotation(request: {
    bookId: string;
    highlightId: string;
  }): Promise<void>;
  loadNote(request: { bookId: string }): Promise<NoteSnapshot>;
  saveNote(request: SaveNoteRequest): Promise<NoteSnapshot>;
  createNoteSource(request: CreateNoteSourceRequest): Promise<SourceAnchor>;
  exportNote(request: { document: string }): Promise<boolean>;
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
  coverMimeType?: string | null;
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
export interface ReaderImage {
  blockIndex: number;
  offset: number;
  src: string;
  alt: string;
  inline?: boolean;
  width?: number;
  height?: number;
  displayWidth?: string;
  displayHeight?: string;
}
export interface ReaderLink {
  blockIndex: number;
  offset: number;
  length: number;
  target: ReadingPosition;
}
export interface ReaderChapter {
  id: string;
  title: string;
  blocks: string[];
  images?: ReaderImage[];
  links?: ReaderLink[];
}
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
export interface ReadingRange {
  /** Half-open range in one chapter of the reading adapter. */
  start: ReadingPosition;
  end: ReadingPosition;
}
export interface SourceAnchor {
  schemaVersion: 1;
  anchorId: string;
  bookId: string;
  contentHash: string;
  adapterVersion: number;
  format: BookSummary['format'];
  source: { title: string; author: string; chapterTitle: string };
  range: ReadingRange;
  exact: string;
  prefix: string;
  suffix: string;
  createdAt: string;
}
export interface Excerpt {
  anchor: SourceAnchor;
  /** Reserved for later categorization. Version 1 has no domain editor. */
  domain?: string | null;
}
export type AnchorResolution =
  | { status: 'exact' | 'fallback'; range: ReadingRange }
  | {
      status: 'lost';
      reason: 'book-unavailable' | 'ambiguous' | 'quote-not-found';
    };
export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue';
export interface Highlight {
  highlightId: string;
  anchor: SourceAnchor;
  color: HighlightColor;
  annotation: {
    annotationId: string;
    highlightId: string;
    text: string;
    createdAt: string;
    updatedAt: string;
  } | null;
}
export type AnnotationChange =
  | {
      kind: 'create';
      contentHash: string;
      range: ReadingRange;
      color: HighlightColor;
      text: string;
    }
  | { kind: 'update'; highlightId: string; color: HighlightColor; text: string }
  | { kind: 'remove' | 'undo'; highlightId: string };
export interface AnnotationRequest {
  bookId: string;
  expectedRevision: number;
  change: AnnotationChange;
}
export interface AnnotationSnapshot {
  revision: number;
  items: (Highlight & { resolution: AnchorResolution })[];
  undoHighlightId: string | null;
}
export interface NoteSnapshot {
  bookId: string;
  revision: number;
  document: string;
  updatedAt: string | null;
  resolutions: Record<string, AnchorResolution>;
}
export interface NoteDocument {
  schemaVersion: 1;
  html: string;
  sources: SourceAnchor[];
  importedAnnotationIds: string[];
}
export interface CreateNoteSourceRequest {
  bookId: string;
  contentHash: string;
  range: ReadingRange;
}
export interface SaveNoteRequest {
  bookId: string;
  expectedRevision: number;
  document: string;
}
export interface ImportFailure {
  error: string;
  fileName: string;
}
