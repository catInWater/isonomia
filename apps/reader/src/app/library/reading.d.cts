import type {
  OpenedBook,
  ReaderChapter,
  SaveReadingRequest,
} from '@reader/storage-bridge';
import type { DurableStore } from '../storage/index.cjs';
import type { LibraryManager } from './index.cjs';
export function validReadingRequest(method: string, request: unknown): boolean;
export class ReadingManager {
  constructor(options: {
    root: string;
    store: DurableStore;
    library: LibraryManager;
  });
  openBook(request: { bookId: string }): Promise<OpenedBook>;
  readChapter(request: {
    bookId: string;
    chapterId: string;
  }): Promise<ReaderChapter>;
  saveReading(request: SaveReadingRequest): Promise<{ lastReadAt: string }>;
}
