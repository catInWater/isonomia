import type { Json } from '@reader/storage-bridge';
export interface BookSummary {
  bookId: string;
  title: string;
  author: string;
  format: 'epub' | 'txt';
  contentHash: string;
  fileName: string;
  fileStatus: 'available' | 'removed';
  importedAt: string;
  lastReadAt: string | null;
  chapters: { id: string; title: string }[];
  encoding: string | null;
  notesRemoved?: boolean;
}
export class LibraryError extends Error {
  code: string;
}
export class LibraryManager {
  constructor(options: {
    root: string;
    store: {
      load(id: string): Promise<{ revision: number; data: Json } | null>;
      save(id: string, data: Json, revision: number): Promise<unknown>;
    };
  });
  list(): Promise<BookSummary[]>;
  importFile(sourcePath: string, keepDuplicate?: boolean): Promise<BookSummary>;
  remove(bookId: string, keepNotes: boolean): Promise<BookSummary>;
}
export function parseEpub(buffer: Buffer): {
  title: string;
  author: string;
  chapters: { id: string; title: string; text: string }[];
  hasToc: boolean;
};
export function parseTxt(buffer: Buffer): {
  title: string;
  author: string;
  chapters: { id: string; title: string; text: string }[];
  encoding: string;
};
export function decodeTxt(buffer: Buffer): { text: string; encoding: string };
