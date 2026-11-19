'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MAX_BYTES } = require('./content.cjs');
const DEFAULT_PREFERENCES = Object.freeze({
  mode: 'scroll',
  fontSize: 18,
  lineHeight: 1.6,
  pageMargin: 24,
  fontFamily: 'default',
  theme: 'light',
});
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function object(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
  );
}
function validPreferences(value) {
  return (
    object(value, 'mode,fontSize,lineHeight,pageMargin,fontFamily,theme') &&
    ['scroll', 'paginated'].includes(value.mode) &&
    Number.isFinite(value.fontSize) &&
    value.fontSize >= 12 &&
    value.fontSize <= 36 &&
    Number.isFinite(value.lineHeight) &&
    value.lineHeight >= 1.2 &&
    value.lineHeight <= 2.4 &&
    Number.isFinite(value.pageMargin) &&
    value.pageMargin >= 12 &&
    value.pageMargin <= 64 &&
    ['default', 'serif', 'sans-serif', 'monospace'].includes(
      value.fontFamily,
    ) &&
    ['light', 'dark', 'sepia'].includes(value.theme)
  );
}
function validPosition(value) {
  return (
    object(value, 'chapterId,blockIndex,offset') &&
    /^chapter-[1-9]\d{0,3}$/.test(value.chapterId) &&
    Number.isSafeInteger(value.blockIndex) &&
    value.blockIndex >= 0 &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0
  );
}
function validReadingRequest(method, request) {
  if (!request || !/^book-[a-z0-9]{32}$/.test(request.bookId)) return false;
  if (method === 'openBook') return object(request, 'bookId');
  if (method === 'readChapter')
    return (
      object(request, 'bookId,chapterId') &&
      /^chapter-[1-9]\d{0,3}$/.test(request.chapterId)
    );
  return (
    method === 'saveReading' &&
    object(request, 'bookId,contentHash,position,preferences') &&
    typeof request.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(request.contentHash) &&
    validPosition(request.position) &&
    validPreferences(request.preferences)
  );
}
function checkPosition(chapters, position) {
  if (!validPosition(position)) fail('INVALID_POSITION', '阅读位置无效。');
  const chapter = chapters.find((item) => item.id === position.chapterId);
  const block = chapter?.blocks[position.blockIndex];
  if (
    typeof block !== 'string' ||
    position.offset > block.length ||
    (position.offset > 0 &&
      /[\uD800-\uDBFF]/.test(block[position.offset - 1]) &&
      /[\uDC00-\uDFFF]/.test(block[position.offset] || ''))
  )
    fail('INVALID_POSITION', '阅读位置不在有效正文范围内。');
}
// Version 1 stored literal [alt] placeholders where version 2 uses one image marker.
// Translate legacy content offsets once; never treat an invalid record as a new session.
function legacyPosition(chapters, position) {
  if (!validPosition(position)) fail('INVALID_POSITION', '阅读位置无效。');
  const chapter = chapters.find((item) => item.id === position.chapterId);
  const block = chapter?.blocks[position.blockIndex];
  if (typeof block !== 'string')
    fail('INVALID_POSITION', '阅读位置不在有效正文范围内。');
  let added = 0;
  for (const image of chapter.images || []) {
    if (image.blockIndex !== position.blockIndex) continue;
    const placeholder = (image.alt ? `[${image.alt}]` : '[图片]').replace(
      /\s+/g,
      ' ',
    );
    const legacyStart = image.offset + added;
    if (position.offset <= legacyStart) break;
    if (position.offset < legacyStart + placeholder.length)
      return { ...position, offset: image.offset };
    added += placeholder.length - 1;
  }
  return { ...position, offset: position.offset - added };
}
class ReadingManager {
  constructor({ root, store, library }) {
    this.root = root;
    this.store = store;
    this.library = library;
    this.pending = Promise.resolve();
    this.cache = null;
  }
  _enqueue(action) {
    const next = this.pending.then(action);
    this.pending = next.catch(() => {});
    return next;
  }
  async _content(bookId, forceHash = false) {
    const book = (await this.library.list()).find(
      (item) => item.bookId === bookId,
    );
    if (
      !book ||
      !['txt', 'epub'].includes(book.format) ||
      book.fileName !== `${bookId}.${book.format}`
    )
      fail('NOT_FOUND', '书籍文件不可用。');
    const directory = path.join(this.root, 'books');
    const file = path.join(directory, book.fileName);
    const realDirectory = await fs.realpath(directory).catch(() => '');
    if (
      !realDirectory ||
      (await fs.realpath(file).catch(() => '')) !==
        path.join(realDirectory, book.fileName)
    )
      fail('CONTENT_UNAVAILABLE', '书籍文件不可用。');
    const handle = await fs
      .open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(() => fail('CONTENT_UNAVAILABLE', '书籍文件不可用。'));
    let bytes;
    let stat;
    try {
      stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        fail('CONTENT_LIMIT', '书籍文件超过限制。');
      const cacheMatches =
        this.cache?.bookId === bookId &&
        this.cache?.key === `${book.contentHash}:${book.format}` &&
        this.cache?.size === stat.size &&
        this.cache?.mtimeMs === stat.mtimeMs &&
        this.cache?.ctimeMs === stat.ctimeMs &&
        this.cache?.dev === stat.dev &&
        this.cache?.ino === stat.ino;
      if (!forceHash && cacheMatches)
        return { book, chapters: this.cache.chapters };
      // Bounded reads also cover a file growing after stat.
      bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(
          bytes,
          size,
          bytes.length - size,
          size,
        );
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size !== stat.size)
        fail('CONTENT_CHANGED', '书籍内容已变化，请重新导入。');
      bytes = bytes.subarray(0, size);
    } finally {
      await handle.close();
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== book.contentHash)
      fail('CONTENT_CHANGED', '书籍内容已变化，请重新导入以保留原有阅读位置。');
    const cacheKey = `${hash}:${book.format}`;
    if (
      !this.cache ||
      this.cache.bookId !== bookId ||
      this.cache.key !== cacheKey
    ) {
      const { parseEpub, parseTxt } = require('./index.cjs');
      this.cache = {
        bookId,
        key: cacheKey,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        dev: stat.dev,
        ino: stat.ino,
        chapters: (book.format === 'epub' ? parseEpub(bytes) : parseTxt(bytes))
          .chapters,
      };
    }
    return { book, chapters: this.cache.chapters };
  }
  async _touch(bookId) {
    const catalog = await this.store.load('library');
    const lastReadAt = new Date().toISOString();
    if (
      !catalog?.data.books.some(
        (book) => book.bookId === bookId && book.fileStatus === 'available',
      )
    )
      fail('NOT_FOUND', '书籍文件不可用。');
    await this.store.save(
      'library',
      {
        ...catalog.data,
        books: catalog.data.books.map((book) =>
          book.bookId === bookId ? { ...book, lastReadAt } : book,
        ),
      },
      catalog.revision,
    );
    return lastReadAt;
  }
  openBook(request) {
    return this._enqueue(async () => {
      if (!validReadingRequest('openBook', request))
        fail('INVALID_REQUEST', '阅读请求无效。');
      const { book, chapters } = await this._content(request.bookId, true);
      const record = await this.store.load(`reading-${book.bookId}`);
      let position = { chapterId: chapters[0].id, blockIndex: 0, offset: 0 };
      let preferences = { ...DEFAULT_PREFERENCES };
      if (record) {
        if (record.data.contentHash !== book.contentHash)
          fail('CONTENT_CHANGED', '阅读记录的内容版本不匹配，请恢复原始书籍。');
        if (
          record.data.adapterVersion !== undefined &&
          record.data.adapterVersion !== 2
        )
          fail('INVALID_STATE', '阅读记录格式版本不受支持。');
        position =
          record.data.adapterVersion === 2
            ? record.data.position
            : legacyPosition(chapters, record.data.position);
        checkPosition(chapters, position);
        if (!validPreferences(record.data.preferences))
          fail('INVALID_STATE', '阅读设置无效，请恢复阅读记录。');
        preferences = record.data.preferences;
      }
      const lastReadAt = await this._touch(book.bookId);
      const { fileName: _fileName, ...summary } = book;
      return { book: { ...summary, lastReadAt }, position, preferences };
    });
  }
  readChapter(request) {
    return this._enqueue(async () => {
      if (!validReadingRequest('readChapter', request))
        fail('INVALID_REQUEST', '阅读请求无效。');
      const { chapters } = await this._content(request.bookId);
      const chapter = chapters.find((item) => item.id === request.chapterId);
      if (!chapter) fail('NOT_FOUND', '找不到章节。');
      return {
        id: chapter.id,
        title: chapter.title,
        blocks: [...chapter.blocks],
        images: (chapter.images || []).map(({ size: _size, ...image }) => ({
          ...image,
        })),
        links: (chapter.links || []).map((link) => ({
          ...link,
          target: { ...link.target },
        })),
      };
    });
  }
  saveReading(request) {
    return this._enqueue(async () => {
      if (!validReadingRequest('saveReading', request))
        fail('INVALID_REQUEST', '阅读请求无效。');
      const { book, chapters } = await this._content(request.bookId);
      if (request.contentHash !== book.contentHash)
        fail('CONTENT_CHANGED', '阅读记录的内容版本不匹配。');
      checkPosition(chapters, request.position);
      const id = `reading-${book.bookId}`;
      const current = await this.store.load(id);
      if (current && current.data.contentHash !== book.contentHash)
        fail('CONTENT_CHANGED', '阅读记录的内容版本不匹配。');
      const lastReadAt = book.lastReadAt || '';
      const lastReadTime = Date.parse(lastReadAt);
      const shouldTouch =
        !Number.isFinite(lastReadTime) || Date.now() - lastReadTime >= 60_000;
      const savedAt = shouldTouch ? await this._touch(book.bookId) : lastReadAt;
      await this.store.save(
        id,
        {
          adapterVersion: 2,
          contentHash: book.contentHash,
          position: request.position,
          preferences: request.preferences,
        },
        current?.revision ?? 0,
      );
      return { lastReadAt: savedAt || new Date().toISOString() };
    });
  }
}
module.exports = {
  ReadingManager,
  DEFAULT_PREFERENCES,
  validReadingRequest,
  validPosition,
  validPreferences,
};
