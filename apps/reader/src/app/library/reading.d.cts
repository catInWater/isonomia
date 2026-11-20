import type {
  OpenedBook,
  ReaderChapter,
  SaveReadingRequest,
} from '@reader/storage-bridge';
import type { DurableStore } from '../storage/index.cjs';
import type { BookSummary, LibraryManager } from './index.cjs';

export interface VerifiedContent {
  book: BookSummary;
  chapters: ReaderChapter[];
}

export function validReadingRequest(method: string, request: unknown): boolean;
export class ReadingManager {
  constructor(options: {
    root: string;
    store: DurableStore;
    library: LibraryManager;
  });
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
  verifiedContent(
    bookId: string,
    forceHash?: boolean,
  ): Promise<VerifiedContent>;
  openBook(request: { bookId: string }): Promise<OpenedBook>;
  readChapter(request: {
    bookId: string;
    chapterId: string;
  }): Promise<ReaderChapter>;
  saveReading(request: SaveReadingRequest): Promise<{ lastReadAt: string }>;
}
