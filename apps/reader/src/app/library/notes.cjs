'use strict';

function validBookId(value) {
  return typeof value === 'string' && /^book-[a-z0-9]{32}$/.test(value);
}
function validNoteRequest(method, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return false;
  if (method === 'loadNote') return validBookId(request.bookId);
  return (
    validBookId(request.bookId) &&
    Number.isSafeInteger(request.expectedRevision) &&
    request.expectedRevision >= 0 &&
    typeof request.document === 'string' &&
    request.document.length <= 500_000
  );
}

class NotesManager {
  constructor({ store, library }) {
    this.store = store;
    this.library = library;
  }
  async load({ bookId }) {
    if (!validBookId(bookId)) throw new Error('笔记请求无效。');
    const book = await this.library.findBook(bookId);
    if (!book) throw new Error('找不到这本书。');
    const record = await this.store.load(`note-${bookId}`);
    return {
      bookId,
      revision: record?.revision ?? 0,
      document: record?.data?.document ?? '',
      updatedAt: record?.data?.updatedAt ?? null,
    };
  }
  async save({ bookId, expectedRevision, document }) {
    if (!validNoteRequest('saveNote', { bookId, expectedRevision, document }))
      throw new Error('笔记请求无效。');
    const record = await this.store.save(
      `note-${bookId}`,
      {
        document,
        updatedAt: new Date().toISOString(),
        noteId: `note-${bookId}`,
      },
      expectedRevision,
    );
    return {
      bookId,
      revision: record.revision,
      document,
      updatedAt: record.data.updatedAt,
    };
  }
  async remove(bookId) {
    if (validBookId(bookId)) await this.store.remove(`note-${bookId}`);
  }
}
module.exports = { NotesManager, validNoteRequest };
