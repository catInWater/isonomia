'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const {
  LibraryManager,
} = require('../../apps/reader/src/app/library/index.cjs');
const {
  DEFAULT_PREFERENCES,
  ReadingManager,
} = require('../../apps/reader/src/app/library/reading.cjs');
const {
  AnnotationsManager,
} = require('../../apps/reader/src/app/library/annotations.cjs');
const { epub } = require('../../tools/fixtures.cjs');

async function setup(t, checkpoint) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-annotations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  function reopen(checkpoint) {
    const store = new DurableStore({
      root: path.join(root, 'data'),
      schemaVersion: 1,
      schemas: {
        1: (data) =>
          data !== null && typeof data === 'object' && !Array.isArray(data),
      },
      checkpoint,
    });
    const library = new LibraryManager({ root, store });
    const reading = new ReadingManager({ root, store, library });
    const annotations = new AnnotationsManager({ store, library, reading });
    return { store, library, reading, annotations };
  }
  async function source(name, bytes) {
    const file = path.join(root, name);
    await fs.writeFile(file, bytes);
    return file;
  }
  return { root, source, reopen, ...reopen(checkpoint) };
}

const originalText = '第一章 渡口\n左岸。候船到此！右岸。\n';
const position = (blockIndex, offset) => ({
  chapterId: 'chapter-1',
  blockIndex,
  offset,
});
const range = (blockIndex, start, end) => ({
  start: position(blockIndex, start),
  end: position(blockIndex, end),
});
const selection = range(0, 3, 8);
const create = (book, overrides = {}) => ({
  kind: 'create',
  contentHash: book.contentHash,
  range: selection,
  color: 'yellow',
  text: '旧批注',
  ...overrides,
});
const change = (manager, bookId, expectedRevision, change) =>
  manager.change({ bookId, expectedRevision, change });

test('S03-A4: different highlight colors and edited notes persist without moving reading progress', async (t) => {
  const { store, library, reading, annotations, source, reopen } =
    await setup(t);
  const book = await library.importFile(await source('渡口.txt', originalText));
  const { bookId, contentHash } = book;
  const readingPosition = position(0, 11);
  const preferences = {
    ...DEFAULT_PREFERENCES,
    fontSize: 24,
    mode: 'paginated',
  };
  await reading.saveReading({
    bookId,
    contentHash,
    position: readingPosition,
    preferences,
  });
  const progress = await store.load(`reading-${bookId}`);

  assert.deepEqual(await annotations.list({ bookId }), {
    revision: 0,
    items: [],
    undoHighlightId: null,
  });
  const first = await change(annotations, bookId, 0, create(book));
  assert.equal(first.revision, 1);
  assert.equal(first.items.length, 1);
  const [item] = first.items;
  const { highlightId, anchor, annotation } = item;
  assert.equal(item.color, 'yellow');
  assert.equal(anchor.exact, '候船到此！');
  assert.deepEqual(item.resolution, { status: 'exact', range: selection });
  assert.equal(annotation.highlightId, highlightId);
  assert.equal(annotation.text, '旧批注');
  assert.match(annotation.annotationId, /^annotation-.+/);
  assert.ok(Number.isFinite(Date.parse(annotation.createdAt)));

  const second = await change(
    annotations,
    bookId,
    first.revision,
    create(book, {
      range: range(0, 8, 11),
      color: 'green',
      text: '',
    }),
  );
  const other = second.items.find(
    (highlight) => highlight.highlightId !== highlightId,
  );
  assert.ok(other, 'the new highlight must have its own ID');
  assert.equal(other.color, 'green');
  assert.equal(other.anchor.exact, '右岸。');
  assert.equal(other.annotation, null);
  const updated = await change(annotations, bookId, second.revision, {
    kind: 'update',
    highlightId,
    color: 'blue',
    text: '修改后的批注',
  });
  assert.equal(updated.revision, second.revision + 1);
  assert.equal(updated.items.length, 2);
  const edited = updated.items.find(
    (highlight) => highlight.highlightId === highlightId,
  );
  assert.equal(edited.color, 'blue');
  assert.deepEqual(edited.anchor, anchor);
  assert.deepEqual(edited.resolution, item.resolution);
  assert.equal(edited.annotation.annotationId, annotation.annotationId);
  assert.equal(edited.annotation.highlightId, highlightId);
  assert.equal(edited.annotation.createdAt, annotation.createdAt);
  assert.equal(edited.annotation.text, '修改后的批注');
  assert.ok(
    Date.parse(edited.annotation.updatedAt) >= Date.parse(annotation.createdAt),
  );
  assert.deepEqual(
    updated.items.find(
      (highlight) => highlight.highlightId === other.highlightId,
    ),
    other,
  );

  await assert.rejects(
    change(annotations, bookId, second.revision, {
      kind: 'remove',
      highlightId,
    }),
  );
  const restarted = reopen();
  assert.deepEqual(await restarted.annotations.list({ bookId }), updated);
  assert.deepEqual(await restarted.store.load(`reading-${bookId}`), progress);
  const resumed = await restarted.reading.openBook({ bookId });
  assert.deepEqual(resumed.position, readingPosition);
  assert.deepEqual(resumed.preferences, preferences);
});

test('S03-A5: failed deletes and undos leave disk unchanged; reopening can restore the same note and highlight', async (t) => {
  let full = false;
  let failures = 0;
  const { store, library, annotations, source, reopen } = await setup(
    t,
    (stage) => {
      if (full && stage === 'after-file-sync') {
        failures++;
        throw Object.assign(new Error('disk full before publishing revision'), {
          code: 'ENOSPC',
        });
      }
    },
  );
  const book = await library.importFile(await source('渡口.txt', originalText));
  const { bookId } = book;
  const recordId = `annotations-${bookId}`;
  const confirmed = await change(
    annotations,
    bookId,
    0,
    create(book, { color: 'pink' }),
  );
  const { highlightId } = confirmed.items[0];
  const deletion = { kind: 'remove', highlightId };
  const undo = { kind: 'undo', highlightId };

  async function expectFailedChange(prior, action) {
    const previousRecord = await store.load(recordId);
    assert.equal(previousRecord.revision, prior.revision);
    const priorFailures = failures;
    full = true;
    await assert.rejects(change(annotations, bookId, prior.revision, action));
    full = false;
    assert.equal(failures, priorFailures + 1);
    assert.deepEqual(await annotations.list({ bookId }), prior);
    const restarted = reopen();
    assert.deepEqual(await restarted.store.load(recordId), previousRecord);
    assert.deepEqual(await restarted.annotations.list({ bookId }), prior);
  }

  await expectFailedChange(confirmed, deletion);
  const deleted = await change(
    annotations,
    bookId,
    confirmed.revision,
    deletion,
  );
  assert.deepEqual(deleted, {
    revision: confirmed.revision + 1,
    items: [],
    undoHighlightId: highlightId,
  });
  await expectFailedChange(deleted, undo);
  assert.equal(failures, 2);
  const restarted = reopen();
  const restored = await change(
    restarted.annotations,
    bookId,
    deleted.revision,
    undo,
  );
  assert.deepEqual(restored, { ...confirmed, revision: deleted.revision + 1 });
  assert.deepEqual(await reopen().annotations.list({ bookId }), restored);
});

test('S03-A3: replacement reuses the book ID; keeping or purging notes follows the removal choice', async (t) => {
  const { root, store, library, annotations, source, reopen } = await setup(t);
  const originalPath = await source('渡口.txt', originalText);
  const revisedText = '第一章 渡口\n改版说明。\n绕新路，候船到此！\n';
  const revisedPath = await source('新版.txt', revisedText);
  const epubPath = await source('别的格式.epub', epub());
  const book = await library.importFile(originalPath);
  const { bookId } = book;
  const recordId = `annotations-${bookId}`;
  const confirmed = await change(annotations, bookId, 0, create(book));
  const confirmedRecord = await store.load(recordId);
  const [item] = confirmed.items;

  await assert.rejects(library.replaceFile(bookId, epubPath), {
    code: 'UNSUPPORTED_FORMAT',
  });
  assert.deepEqual(await annotations.list({ bookId }), confirmed);
  await fs.unlink(path.join(root, 'books', book.fileName));
  const missing = {
    ...confirmed,
    items: [
      { ...item, resolution: { status: 'lost', reason: 'book-unavailable' } },
    ],
  };
  assert.deepEqual(await annotations.list({ bookId }), missing);

  const replacement = await library.replaceFile(bookId, revisedPath);
  assert.equal(replacement.bookId, bookId);
  assert.equal(replacement.format, book.format);
  assert.notEqual(replacement.contentHash, book.contentHash);
  await assert.rejects(
    change(annotations, bookId, confirmed.revision, create(book)),
  );
  assert.deepEqual(await annotations.list({ bookId }), {
    ...confirmed,
    items: [
      { ...item, resolution: { status: 'fallback', range: range(1, 4, 9) } },
    ],
  });
  assert.deepEqual(await store.load(recordId), confirmedRecord);

  const removed = await library.remove(bookId, true);
  assert.equal(removed.fileStatus, 'removed');
  assert.deepEqual(await library.list(), []);
  await assert.rejects(
    fs.access(path.join(root, 'books', replacement.fileName)),
    { code: 'ENOENT' },
  );
  const restarted = reopen();
  assert.deepEqual(await restarted.annotations.list({ bookId }), missing);
  assert.deepEqual(await restarted.store.load(recordId), confirmedRecord);
  const copy = await restarted.annotations.copyText({
    bookId,
    highlightId: item.highlightId,
  });
  assert.ok(copy.includes('候船到此！'));
  assert.ok(copy.includes(`${book.title} · ${book.author} · 第一章 渡口`));
  assert.ok(copy.includes('旧批注'));

  const restored = await restarted.library.replaceFile(bookId, originalPath);
  assert.equal(restored.bookId, bookId);
  assert.equal(restored.fileStatus, 'available');
  assert.deepEqual(await restarted.annotations.list({ bookId }), confirmed);
  await restarted.library.remove(bookId, false);
  assert.equal(await restarted.store.load(recordId), null);
  assert.deepEqual(await restarted.library.list(true), []);
  assert.equal(await fs.readFile(originalPath, 'utf8'), originalText);
  assert.equal(await fs.readFile(revisedPath, 'utf8'), revisedText);
});
