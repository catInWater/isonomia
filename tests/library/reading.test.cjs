'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const {
  LibraryManager,
  parseEpub,
  parseTxt,
} = require('../../apps/reader/src/app/library/index.cjs');
const {
  ReadingManager,
  DEFAULT_PREFERENCES,
  validReadingRequest,
} = require('../../apps/reader/src/app/library/reading.cjs');
const { zip } = require('../../tools/fixtures.cjs');
const fixtures = path.join(__dirname, '..', 'fixtures');
function epubWith(
  href = 'chapter.xhtml',
  chapter = '<html><body><p>正文</p></body></html>',
) {
  return zip([
    [
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    ],
    [
      'OEBPS/book.opf',
      `<package><metadata><title>测试书</title></metadata><manifest><item id="chapter" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
    ],
    ['OEBPS/chapter.xhtml', chapter],
  ]);
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-reading-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DurableStore({
    root: path.join(root, 'data'),
    schemaVersion: 1,
    schemas: {
      1: (data) => data && typeof data === 'object' && !Array.isArray(data),
    },
  });
  const library = new LibraryManager({ root, store });
  const manager = new ReadingManager({ root, store, library });
  return { root, store, library, manager };
}
test('bounded EPUB adapter returns plain text blocks and rejects active XML or out-of-root resources', async () => {
  const bytes = await fs.readFile(path.join(fixtures, 'chinese.epub'));
  const parsed = parseEpub(bytes);
  assert.ok(
    parsed.chapters[0].blocks.every((block) => typeof block === 'string'),
  );
  assert.match(parsed.chapters[0].blocks.join(' '), /窗外有风/);
  assert.doesNotMatch(
    parsed.chapters[0].blocks.join(' '),
    /<script|<style|javascript:/i,
  );

  const inert = parseEpub(
    epubWith(
      'chapter.xhtml',
      '<html><body><script>globalThis.pwned = true</script><img src="https://example.test/track" alt="书内图片"/><p>安全正文</p></body></html>',
    ),
  );
  assert.equal(inert.chapters[0].blocks.join(' '), '[书内图片] 安全正文');
  assert.throws(() => parseEpub(epubWith('../../secret.xhtml')), {
    code: 'INVALID_EPUB',
  });
  assert.throws(
    () =>
      parseEpub(
        epubWith(
          'chapter.xhtml',
          '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///private">]><html><body>&x;</body></html>',
        ),
      ),
    { code: 'INVALID_EPUB' },
  );
  assert.throws(() => parseEpub(epubWith('https://example.test/book.xhtml')), {
    code: 'INVALID_EPUB',
  });
  assert.throws(() => parseEpub(Buffer.alloc(32 * 1024 * 1024 + 1)), {
    code: 'INVALID_EPUB',
  });
});
test('TXT exposes structured paragraph blocks while preserving encoding and chapters', async () => {
  const parsed = parseTxt(
    await fs.readFile(path.join(fixtures, 'chinese-utf8.txt')),
  );
  assert.ok(parsed.chapters.length >= 2);
  assert.ok(
    parsed.chapters.every((chapter) =>
      chapter.blocks.every((block) => typeof block === 'string'),
    ),
  );
});
test('progress and typography persist; open updates lastReadAt; content changes fail closed', async (t) => {
  const { root, library, manager, store } = await setup(t);
  const book = await library.importFile(
    path.join(fixtures, 'chinese-utf8.txt'),
  );
  const opened = await manager.openBook({ bookId: book.bookId });
  assert.equal(opened.book.contentHash, book.contentHash);
  assert.deepEqual(opened.position, {
    chapterId: 'chapter-1',
    blockIndex: 0,
    offset: 0,
  });
  assert.deepEqual(opened.preferences, DEFAULT_PREFERENCES);
  const chapter = await manager.readChapter({
    bookId: book.bookId,
    chapterId: 'chapter-1',
  });
  assert.ok(chapter.blocks.length);
  const position = {
    chapterId: chapter.id,
    blockIndex: chapter.blocks.length - 1,
    offset: chapter.blocks.at(-1).length,
  };
  const preferences = {
    ...DEFAULT_PREFERENCES,
    mode: 'paginated',
    fontSize: 24,
    lineHeight: 2,
    pageMargin: 32,
    fontFamily: 'serif',
    theme: 'sepia',
  };
  await manager.saveReading({
    bookId: book.bookId,
    contentHash: book.contentHash,
    position,
    preferences,
  });
  const restored = await manager.openBook({ bookId: book.bookId });
  assert.deepEqual(restored.position, position);
  assert.deepEqual(restored.preferences, preferences);
  assert.ok(restored.book.lastReadAt);
  await fs.writeFile(path.join(root, 'books', book.fileName), 'changed');
  await assert.rejects(
    manager.readChapter({ bookId: book.bookId, chapterId: 'chapter-1' }),
    { code: 'CONTENT_CHANGED' },
  );
  assert.ok(await store.load('reading-' + book.bookId));
});
test('reading adapter accepts ordinary external XHTML doctypes without fetching them', () => {
  const bytes = epubWith(
    'chapter.xhtml',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "https://example.test/xhtml.dtd"><html><body><p>静态正文</p></body></html>',
  );
  assert.match(parseEpub(bytes).chapters[0].blocks.join(' '), /静态正文/);
});
test('IPC contract rejects extra fields, invalid settings and out-of-range positions', () => {
  const bookId = `book-${'a'.repeat(32)}`;
  assert.equal(validReadingRequest('openBook', { bookId }), true);
  assert.equal(
    validReadingRequest('openBook', { bookId, path: '/etc/passwd' }),
    false,
  );
  assert.equal(
    validReadingRequest('readChapter', { bookId, chapterId: 'chapter-1' }),
    true,
  );
  assert.equal(
    validReadingRequest('saveReading', {
      bookId,
      contentHash: 'a'.repeat(64),
      position: { chapterId: 'chapter-1', blockIndex: 0, offset: 0 },
      preferences: { ...DEFAULT_PREFERENCES, fontSize: 200 },
    }),
    false,
  );
});
