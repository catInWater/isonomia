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
const { zip, epub } = require('../../tools/fixtures.cjs');
const {
  imageDataUrl,
} = require('../../apps/reader/src/app/library/content.cjs');
const fixtures = path.join(__dirname, '..', 'fixtures');
function epubWith(
  href = 'chapter.xhtml',
  chapter = '<html><body><p>正文</p></body></html>',
  zipOptions = {},
) {
  return zip(
    [
      [
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
      ],
      [
        'OEBPS/book.opf',
        `<package><metadata><title>测试书</title></metadata><manifest><item id="chapter" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
      ],
      ['OEBPS/chapter.xhtml', chapter],
    ],
    zipOptions,
  );
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
  assert.equal(
    parseEpub(
      epubWith(
        'chapter.xhtml',
        '<html><body><img src="../../secret.png" alt="越界图片"/><p>仍可读</p></body></html>',
        { flags: 0x0816, method: 8 },
      ),
    ).chapters[0].blocks.join(' '),
    '[越界图片] 仍可读',
  );
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
test('oversized image dimensions are rejected before making renderable data URLs', () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(20_000, 16);
  bytes.writeUInt32BE(1, 20);
  assert.equal(imageDataUrl(bytes, 'image/png'), null);
});
test('common EPUB ZIP flags are accepted and safe cover/inline images are extracted', async () => {
  const parsed = parseEpub(
    await fs.readFile(path.join(fixtures, 'epub-images.epub')),
  );
  assert.equal(parsed.cover.mediaType, 'image/png');
  assert.equal(parsed.chapters[0].images.length, 1);
  assert.equal(parsed.chapters[0].images[0].alt, '红色像素');
  assert.equal(parsed.chapters[0].images[0].blockIndex, 1);
  assert.match(parsed.chapters[0].images[0].src, /^data:image\/png;base64,/);
  assert.ok(parsed.chapters[0].blocks[1].includes('￼'));
  assert.throws(
    () =>
      parseEpub(
        epubWith(
          'chapter.xhtml',
          '<html><body><p>encrypted</p></body></html>',
          { flags: 0x0801 },
        ),
      ),
    { code: 'INVALID_EPUB' },
  );
});
test('image offsets follow normalized whitespace and repeated inline references', () => {
  const parsed = parseEpub(
    epub({
      images: true,
      body: '<p>  前文 \n <img src="images/pixel.png"/> 后文 <img class="inline" src="images/pixel.png" alt="像素"/>  </p>',
    }),
  );
  const chapter = parsed.chapters[0];
  const blockIndex = chapter.images[0].blockIndex;
  assert.equal(chapter.blocks[blockIndex], '前文 ￼ 后文 ￼');
  assert.equal(chapter.images.length, 2);
  assert.equal(chapter.images[0].inline, false);
  assert.equal(chapter.images[1].inline, true);
  assert.deepEqual(
    chapter.images.map((image) => image.offset),
    [3, 8],
  );
  for (const image of chapter.images) {
    assert.equal(chapter.blocks[image.blockIndex][image.offset], '￼');
    assert.match(image.src, /^data:image\/png;base64,/);
    assert.equal('assetId' in image, false);
  }
});
test('EPUB 3 covers use manifest properties and unsafe image types fall back to alt text', async () => {
  const png = parseEpub(
    await fs.readFile(path.join(fixtures, 'epub-images.epub')),
  ).cover.bytes;
  const build = (mediaType, bytes) =>
    zip([
      [
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      ],
      [
        'book.opf',
        `<package version="3.0"><metadata><title>EPUB 3</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="art" href="art.png" media-type="${mediaType}" properties="cover-image"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
      ],
      [
        'chapter.xhtml',
        '<html><body><p><img src="art.png" alt="插图"/></p><p>安全正文</p></body></html>',
      ],
      ['art.png', bytes],
    ]);
  assert.equal(parseEpub(build('image/png', png)).cover.mediaType, 'image/png');
  for (const [mediaType, bytes] of [
    ['image/jpeg', png],
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['image/png', Buffer.from('not an image')],
  ]) {
    const parsed = parseEpub(build(mediaType, bytes));
    assert.equal(parsed.cover, null);
    assert.equal(parsed.chapters[0].images.length, 0);
    assert.equal(parsed.chapters[0].blocks.join(' '), '[插图] 安全正文');
  }
});
test('repeated image references stay bounded and excess images keep readable placeholders', () => {
  const parsed = parseEpub(
    epub({
      images: true,
      body: `<p>${'<img src="images/pixel.png" alt="像素"/>'.repeat(4100)}</p>`,
    }),
  );
  assert.equal(parsed.chapters[0].images.length, 4096);
  assert.ok(parsed.chapters[0].blocks[0].endsWith('[像素]'.repeat(4)));
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
test('library reads return safe inline images without EPUB file paths', async (t) => {
  const { library, manager } = await setup(t);
  const book = await library.importFile(
    path.join(fixtures, 'epub-images.epub'),
  );
  const opened = await manager.openBook({ bookId: book.bookId });
  const chapter = await manager.readChapter({
    bookId: opened.book.bookId,
    chapterId: 'chapter-1',
  });
  assert.equal(chapter.images.length, 1);
  assert.match(chapter.images[0].src, /^data:image\/png;base64,/);
  assert.ok(chapter.blocks[1].includes('￼'));
  assert.equal('fileName' in opened.book, false);
});
test('legacy image-placeholder reading positions migrate without resetting or migrating twice', async (t) => {
  const { library, manager, store } = await setup(t);
  const book = await library.importFile(
    path.join(fixtures, 'epub-images.epub'),
  );
  const chapter = await manager.readChapter({
    bookId: book.bookId,
    chapterId: 'chapter-1',
  });
  const image = chapter.images[0];
  const block = chapter.blocks[image.blockIndex];
  const oldBlock = block.replace('￼', `[${image.alt}]`);
  const id = `reading-${book.bookId}`;
  for (const [oldOffset, expected] of [
    [image.offset - 1, image.offset - 1],
    [image.offset + 2, image.offset],
    [oldBlock.length, block.length],
  ]) {
    const current = await store.load(id);
    await store.save(
      id,
      {
        contentHash: book.contentHash,
        position: {
          chapterId: chapter.id,
          blockIndex: image.blockIndex,
          offset: oldOffset,
        },
        preferences: DEFAULT_PREFERENCES,
      },
      current?.revision ?? 0,
    );
    const opened = await manager.openBook({ bookId: book.bookId });
    assert.equal(opened.position.offset, expected);
    await manager.saveReading({
      bookId: book.bookId,
      contentHash: book.contentHash,
      position: opened.position,
      preferences: opened.preferences,
    });
    assert.equal((await store.load(id)).data.adapterVersion, 2);
    assert.deepEqual(
      (await manager.openBook({ bookId: book.bookId })).position,
      opened.position,
    );
  }
  const current = await store.load(id);
  await store.save(
    id,
    { ...current.data, adapterVersion: 99 },
    current.revision,
  );
  await assert.rejects(manager.openBook({ bookId: book.bookId }), {
    code: 'INVALID_STATE',
  });
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
  const catalog = await store.load('library');
  catalog.data.books = catalog.data.books.map((item) =>
    item.bookId === book.bookId
      ? { ...item, lastReadAt: '2000-01-01T00:00:00.000Z' }
      : item,
  );
  await store.save('library', catalog.data, catalog.revision);
  const saved = await manager.saveReading({
    bookId: book.bookId,
    contentHash: book.contentHash,
    position,
    preferences,
  });
  assert.ok(
    Date.parse(saved.lastReadAt) > Date.parse('2000-01-01T00:00:00.000Z'),
  );
  assert.equal(
    (await store.load('library')).data.books[0].lastReadAt,
    saved.lastReadAt,
  );
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
