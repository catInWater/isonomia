import type { DurableStore } from '../storage/index.cjs';
import type { LibraryManager } from './index.cjs';
import type { ReadingManager } from './reading.cjs';
import type {
  CreateNoteSourceRequest,
  SaveNoteRequest,
  NoteSnapshot,
  SourceAnchor,
} from '@reader/storage-bridge';
export function validNoteRequest(method: string, request: unknown): boolean;
export class NotesManager {
  constructor(options: {
    store: DurableStore;
    library: LibraryManager;
    reading: ReadingManager;
  });
  load(request: { bookId: string }): Promise<NoteSnapshot>;
  createSource(request: CreateNoteSourceRequest): Promise<SourceAnchor>;
  save(request: SaveNoteRequest): Promise<NoteSnapshot>;
  remove(bookId: string): Promise<void>;
}
