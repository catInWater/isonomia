import type { DurableStore } from '../storage/index.cjs';
import type { LibraryManager } from './index.cjs';
import type { SaveNoteRequest, NoteSnapshot } from '@reader/storage-bridge';
export function validNoteRequest(method: string, request: unknown): boolean;
export class NotesManager {
  constructor(options: { store: DurableStore; library: LibraryManager });
  load(request: { bookId: string }): Promise<NoteSnapshot>;
  save(request: SaveNoteRequest): Promise<NoteSnapshot>;
  remove(bookId: string): Promise<void>;
}
