'use strict';

const { randomUUID } = require('node:crypto');
const {
  createAnchor,
  createAnchorResolver,
  sourceLine,
  validRange,
} = require('./anchors.cjs');

const COLORS = ['yellow', 'green', 'pink', 'blue'];
const MAX_TEXT = 8_000;
const UNAVAILABLE = new Set([
  'NOT_FOUND',
  'CONTENT_CHANGED',
  'CONTENT_UNAVAILABLE',
  'CONTENT_LIMIT',
]);
const validId = (value, prefix) =>
  typeof value === 'string' &&
  value.startsWith(`${prefix}-`) &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
    value.slice(prefix.length + 1),
  );
const validBookId = (value) =>
  typeof value === 'string' && /^book-[a-z0-9]{32}$/.test(value);
const keys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === expected;
const validHash = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validText = (value) =>
  typeof value === 'string' && value.length <= MAX_TEXT;

function validAnnotationRequest(method, request) {
  if (!validBookId(request?.bookId)) return false;
  if (method === 'listAnnotations') return keys(request, 'bookId');
  if (method === 'copyAnnotation')
    return (
      keys(request, 'bookId,highlightId') &&
      validId(request.highlightId, 'highlight')
    );
  if (
    method !== 'changeAnnotation' ||
    !keys(request, 'bookId,change,expectedRevision') ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    return false;
  const change = request.change;
  switch (change?.kind) {
    case 'create':
      return (
        keys(change, 'color,contentHash,kind,range,text') &&
        COLORS.includes(change.color) &&
        validText(change.text) &&
        validHash(change.contentHash) &&
        validRange(change.range)
      );
    case 'update':
      return (
        keys(change, 'color,highlightId,kind,text') &&
        validId(change.highlightId, 'highlight') &&
        COLORS.includes(change.color) &&
        validText(change.text)
      );
    case 'remove':
    case 'undo':
      return (
        keys(change, 'highlightId,kind') &&
        validId(change.highlightId, 'highlight')
      );
    default:
      return false;
  }
}

function validHighlight(item, bookId) {
  const anchor = item?.anchor;
  const annotation = item?.annotation;
  return (
    validId(item?.highlightId, 'highlight') &&
    COLORS.includes(item.color) &&
    anchor?.schemaVersion === 1 &&
    validId(anchor.anchorId, 'anchor') &&
    anchor.bookId === bookId &&
    validHash(anchor.contentHash) &&
    Number.isSafeInteger(anchor.adapterVersion) &&
    ['epub', 'txt'].includes(anchor.format) &&
    validRange(anchor.range) &&
    [
      anchor.exact,
      anchor.prefix,
      anchor.suffix,
      anchor.createdAt,
      anchor.source?.title,
      anchor.source?.author,
      anchor.source?.chapterTitle,
    ].every((value) => typeof value === 'string') &&
    (annotation === null ||
      (validId(annotation?.annotationId, 'annotation') &&
        annotation.highlightId === item.highlightId &&
        validText(annotation.text) &&
        typeof annotation.createdAt === 'string' &&
        typeof annotation.updatedAt === 'string'))
  );
}

function noteFor(item, text, now) {
  if (!text.trim()) return null;
  return {
    annotationId: item.annotation?.annotationId || `annotation-${randomUUID()}`,
    highlightId: item.highlightId,
    text,
    createdAt: item.annotation?.createdAt || now,
    updatedAt: now,
  };
}

class AnnotationsManager {
  constructor({ store, library, reading }) {
    this.store = store;
    this.library = library;
    this.reading = reading;
  }

  async _load(bookId) {
    if (!(await this.library.findBook(bookId)))
      throw new Error('找不到这本书。');
    const record = await this.store
      .load(`annotations-${bookId}`)
      .catch((error) => {
        if (error.code !== 'RECOVERY_REQUIRED') throw error;
        throw new Error('批注记录无法读取。请保留本地数据，不要覆盖原记录。', {
          cause: error,
        });
      });
    if (!record)
      return { revision: 0, data: { schemaVersion: 1, items: [], undo: null } };
    const { data } = record;
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.items) ||
      !data.items.every((item) => validHighlight(item, bookId)) ||
      !(data.undo === null || validHighlight(data.undo, bookId))
    )
      throw new Error('批注记录的版本或格式不受支持，原记录未更改。');
    return record;
  }

  async _content(bookId) {
    try {
      return await this.reading.verifiedContent(bookId);
    } catch (error) {
      if (!UNAVAILABLE.has(error.code)) throw error;
      return null;
    }
  }

  _snapshot(revision, data, content) {
    const resolve = createAnchorResolver(content);
    return {
      revision,
      items: data.items.map((item) => ({
        ...item,
        resolution: resolve(item.anchor),
      })),
      undoHighlightId: data.undo?.highlightId ?? null,
    };
  }

  list(request) {
    return this.reading.runExclusive(async () => {
      if (!validAnnotationRequest('listAnnotations', request))
        throw new Error('批注请求无效。');
      const { revision, data } = await this._load(request.bookId);
      const content = data.items.length
        ? await this._content(request.bookId)
        : null;
      return this._snapshot(revision, data, content);
    });
  }

  change(request) {
    return this.reading.runExclusive(async () => {
      if (!validAnnotationRequest('changeAnnotation', request))
        throw new Error('批注请求无效。');
      const { bookId, change, expectedRevision } = request;
      const { revision, data } = await this._load(bookId);
      if (revision !== expectedRevision)
        throw new Error('批注记录已变化，请重新载入后核对。');
      const now = new Date().toISOString();
      const content = await this._content(bookId);
      if (change.kind === 'create') {
        if (!content || change.contentHash !== content.book.contentHash)
          throw new Error('书籍正文已变更或不可用，请重新打开后再选择。');
        const item = {
          highlightId: `highlight-${randomUUID()}`,
          color: change.color,
          anchor: createAnchor(content, change.range, now),
          annotation: null,
        };
        item.annotation = noteFor(item, change.text, now);
        data.items.push(item);
      } else if (change.kind === 'undo') {
        if (data.undo?.highlightId !== change.highlightId)
          throw new Error('没有可以撤销的删除。');
        data.items.push(data.undo);
        data.undo = null;
      } else {
        const index = data.items.findIndex(
          (item) => item.highlightId === change.highlightId,
        );
        if (index < 0) throw new Error('找不到这条划线。');
        const item = data.items[index];
        if (change.kind === 'remove') {
          data.undo = item;
          data.items.splice(index, 1);
        } else {
          item.color = change.color;
          if (change.text !== (item.annotation?.text ?? ''))
            item.annotation = noteFor(item, change.text, now);
        }
      }
      const snapshot = this._snapshot(revision + 1, data, content);
      await this.store
        .save(`annotations-${bookId}`, data, revision)
        .catch((error) => {
          throw new Error(
            '无法确认批注已保存。请检查磁盘空间和权限，重新载入后核对再重试。',
            { cause: error },
          );
        });
      return snapshot;
    });
  }

  copyText(request) {
    return this.reading.runExclusive(async () => {
      if (!validAnnotationRequest('copyAnnotation', request))
        throw new Error('批注请求无效。');
      const { data } = await this._load(request.bookId);
      const item = data.items.find(
        ({ highlightId }) => highlightId === request.highlightId,
      );
      if (!item) throw new Error('找不到这条划线。');
      const quote = item.anchor.exact.replaceAll('￼', '[图片]');
      return `原文：${quote}\n出处：${sourceLine(item.anchor)}${item.annotation?.text ? `\n批注：${item.annotation.text}` : ''}`;
    });
  }
}

module.exports = { AnnotationsManager, validAnnotationRequest };
