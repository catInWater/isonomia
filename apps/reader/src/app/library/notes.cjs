'use strict';

const { isDeepStrictEqual } = require('node:util');
const { StorageError } = require('../storage/index.cjs');
const {
  createAnchor,
  createAnchorResolver,
  validRange,
} = require('./anchors.cjs');

const MAX_DOCUMENT = 500_000;
const MAX_SOURCES = 1_000;
const MAX_IMPORTS = 5_000;
const UNAVAILABLE = new Set([
  'NOT_FOUND',
  'CONTENT_CHANGED',
  'CONTENT_UNAVAILABLE',
  'CONTENT_LIMIT',
]);
const keys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === expected;
const text = (value, max) => typeof value === 'string' && value.length <= max;
const validBookId = (value) =>
  typeof value === 'string' && /^book-[a-z0-9]{32}$/.test(value);
const validHash = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validId = (value, prefix) =>
  typeof value === 'string' &&
  new RegExp(`^${prefix}-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`).test(
    value,
  );
const timestamp = (value) =>
  text(value, 64) && Number.isFinite(Date.parse(value));

function validSource(anchor, bookId) {
  return (
    keys(
      anchor,
      'adapterVersion,anchorId,bookId,contentHash,createdAt,exact,format,prefix,range,schemaVersion,source,suffix',
    ) &&
    anchor.schemaVersion === 1 &&
    validId(anchor.anchorId, 'anchor') &&
    anchor.bookId === bookId &&
    validHash(anchor.contentHash) &&
    Number.isSafeInteger(anchor.adapterVersion) &&
    anchor.adapterVersion >= 1 &&
    ['txt', 'epub'].includes(anchor.format) &&
    validRange(anchor.range) &&
    keys(anchor.source, 'author,chapterTitle,title') &&
    Object.values(anchor.source).every((value) => text(value, 16_000)) &&
    text(anchor.exact, 16_000) &&
    Boolean(anchor.exact.replace(/[\s￼]/g, '')) &&
    text(anchor.prefix, 32) &&
    text(anchor.suffix, 32) &&
    timestamp(anchor.createdAt)
  );
}

function validSources(sources, bookId) {
  return (
    Array.isArray(sources) &&
    sources.length <= MAX_SOURCES &&
    sources.every((anchor) => validSource(anchor, bookId)) &&
    new Set(sources.map((anchor) => anchor.anchorId)).size === sources.length
  );
}

function parseDocument(document, bookId, legacy = false) {
  if (!text(document, MAX_DOCUMENT))
    throw new Error('笔记文档过大或格式无效。');
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    // Only the old raw HTML/empty representation is migrated in memory. Broken
    // JSON must never be mistaken for an empty note and overwritten on save.
    if (legacy && (!document.trim() || /^\s*</.test(document))) {
      value = {
        schemaVersion: 1,
        html: document,
        sources: [],
        importedAnnotationIds: [],
      };
      const migrated = JSON.stringify(value);
      if (migrated.length <= MAX_DOCUMENT) return { value, document: migrated };
    }
    throw new Error('笔记记录的版本或格式不受支持，原记录未更改。');
  }
  if (
    !keys(value, 'html,importedAnnotationIds,schemaVersion,sources') ||
    value.schemaVersion !== 1 ||
    !text(value.html, MAX_DOCUMENT) ||
    !validSources(value.sources, bookId) ||
    !Array.isArray(value.importedAnnotationIds) ||
    value.importedAnnotationIds.length > MAX_IMPORTS ||
    !value.importedAnnotationIds.every((id) => validId(id, 'annotation')) ||
    new Set(value.importedAnnotationIds).size !==
      value.importedAnnotationIds.length
  )
    throw new Error('笔记记录的版本或格式不受支持，原记录未更改。');
  return { value, document };
}

function validNoteRequest(method, request) {
  if (!validBookId(request?.bookId)) return false;
  if (method === 'loadNote') return keys(request, 'bookId');
  if (method === 'createNoteSource')
    return (
      keys(request, 'bookId,contentHash,range') &&
      validHash(request.contentHash) &&
      Boolean(validRange(request.range))
    );
  if (
    method !== 'saveNote' ||
    !keys(request, 'bookId,document,expectedRevision') ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    return false;
  try {
    parseDocument(request.document, request.bookId);
    return true;
  } catch {
    return false;
  }
}

class NotesManager {
  constructor({ store, library, reading }) {
    this.store = store;
    this.library = library;
    this.reading = reading;
  }

  async _load(bookId) {
    const record = await this.store.load(`note-${bookId}`);
    const parsed = parseDocument(
      record ? record.data.document : '',
      bookId,
      true,
    );
    const snapshots =
      record?.data.sourceSnapshots === undefined
        ? parsed.value.sources
        : record.data.sourceSnapshots;
    if (
      !validSources(snapshots, bookId) ||
      JSON.stringify(snapshots).length > MAX_DOCUMENT ||
      (record?.data.updatedAt !== undefined &&
        !timestamp(record.data.updatedAt))
    )
      throw new Error('笔记记录的版本或格式不受支持，原记录未更改。');
    const byId = new Map(snapshots.map((anchor) => [anchor.anchorId, anchor]));
    if (
      parsed.value.sources.some(
        (anchor) => !isDeepStrictEqual(byId.get(anchor.anchorId), anchor),
      )
    )
      throw new Error('笔记来源快照不一致，原记录未更改。');
    return {
      revision: record?.revision ?? 0,
      updatedAt: record?.data.updatedAt ?? null,
      ...parsed,
      snapshots,
    };
  }

  async _resolutions(bookId, sources) {
    let content = null;
    if (sources.length) {
      try {
        content = await this.reading.verifiedContent(bookId);
      } catch (error) {
        if (!UNAVAILABLE.has(error.code)) throw error;
      }
    }
    const resolve = createAnchorResolver(content);
    return Object.fromEntries(
      sources.map((anchor) => [anchor.anchorId, resolve(anchor)]),
    );
  }

  async load(request) {
    if (!validNoteRequest('loadNote', request))
      throw new Error('笔记请求无效。');
    const { bookId } = request;
    return this.reading.runExclusive(async () => {
      const { revision, document, updatedAt, value } = await this._load(bookId);
      return {
        bookId,
        revision,
        document,
        updatedAt,
        resolutions: await this._resolutions(bookId, value.sources),
      };
    });
  }

  async createSource(request) {
    if (!validNoteRequest('createNoteSource', request))
      throw new Error('笔记来源请求无效。');
    const { bookId, contentHash, range } = JSON.parse(JSON.stringify(request));
    return this.reading.runExclusive(async () => {
      const content = await this.reading.verifiedContent(bookId);
      if (content.book.contentHash !== contentHash)
        throw new Error('书籍正文已变更，请重新打开后再选择。');
      return createAnchor(content, range);
    });
  }

  async save(request) {
    if (!validNoteRequest('saveNote', request))
      throw new Error('笔记请求无效。');
    const { bookId, expectedRevision, document } = request;
    const { value } = parseDocument(document, bookId);
    return this.reading.runExclusive(async () => {
      if (!(await this.library.findBook(bookId)))
        throw new Error('找不到这本书。');
      const previous = await this._load(bookId);
      if (previous.revision !== expectedRevision)
        throw new StorageError(
          'STALE_REVISION',
          '笔记记录已变化，请重新载入后核对。',
          {
            actualRevision: previous.revision,
          },
        );
      // Keep a bounded immutable ledger even if a citation is removed from the
      // document, so undo/reinsert cannot silently edit a persisted snapshot.
      const snapshots = new Map(
        previous.snapshots.map((anchor) => [anchor.anchorId, anchor]),
      );
      for (const anchor of value.sources) {
        const persisted = snapshots.get(anchor.anchorId);
        if (persisted && !isDeepStrictEqual(persisted, anchor))
          throw new Error('已保存的笔记来源快照不能修改。');
        snapshots.set(anchor.anchorId, anchor);
      }
      const sourceSnapshots = [...snapshots.values()];
      if (
        sourceSnapshots.length > MAX_SOURCES ||
        JSON.stringify(sourceSnapshots).length > MAX_DOCUMENT
      )
        throw new Error('笔记来源数量或大小超过限制。');
      const updatedAt = new Date().toISOString();
      const resolutions = await this._resolutions(bookId, value.sources);
      // Do not acknowledge, retry, or roll back an ambiguous publication error.
      // DurableStore's code/cause tells callers to reload before another save.
      const record = await this.store.save(
        `note-${bookId}`,
        { document, updatedAt, noteId: `note-${bookId}`, sourceSnapshots },
        expectedRevision,
      );
      return {
        bookId,
        revision: record.revision,
        document,
        updatedAt,
        resolutions,
      };
    });
  }

  async remove(bookId) {
    if (validBookId(bookId)) await this.store.remove(`note-${bookId}`);
  }
}
module.exports = { NotesManager, validNoteRequest };
