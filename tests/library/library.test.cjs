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
const fixture = (name) => path.join(__dirname, '..', 'fixtures', name);
const schema = { 1: (data) => data && Array.isArray(data.books) };
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-library-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DurableStore({
    root: path.join(root, 'data'),
    schemaVersion: 1,
    schemas: schema,
  });
  return { root, manager: new LibraryManager({ root, store }) };
}
test('S01-A1 parses EPUB metadata and chapters', async () => {
  const parsed = parseEpub(await fs.readFile(fixture('chinese.epub')));
  assert.equal(parsed.title, '合成测试书');
  assert.equal(parsed.author, 'Reader fixture contributors');
  assert.ok(parsed.chapters.length >= 1);
});
test('S01-A2 decodes UTF-8, BOM, and GBK TXT fixtures', async () => {
  for (const name of [
    'chinese-utf8.txt',
    'chinese-bom.txt',
    'chinese-gbk.txt',
  ]) {
    const parsed = parseTxt(await fs.readFile(fixture(name)));
    assert.ok(parsed.chapters[0].text.length > 0);
  }
  assert.doesNotThrow(() => parseTxt(Buffer.from('第一章\n中文正文', 'utf8')));
});
test('S01-A2 keeps malformed EPUB as a clear failure', async () => {
  const bytes = await fs.readFile(fixture('malformed.epub'));
  assert.throws(() => parseEpub(bytes), { code: 'INVALID_EPUB' });
});
test('S01-A3/A4 imports a private copy and records removal without touching source', async (t) => {
  const { root, manager } = await setup(t);
  const source = fixture('chinese-utf8.txt');
  const book = await manager.importFile(source);
  assert.equal((await manager.list()).length, 1);
  assert.notEqual(book.fileName, path.basename(source));
  await manager.remove(book.bookId, true);
  assert.equal((await manager.list()).length, 0);
  await fs.access(source);
});
test('deleting book and user content removes its saved reading record', async (t) => {
  const { manager } = await setup(t);
  const book = await manager.importFile(fixture('chinese-utf8.txt'));
  await manager.store.save(
    `reading-${book.bookId}`,
    {
      books: [],
      position: { chapterId: 'chapter-1', blockIndex: 0, offset: 0 },
    },
    0,
  );
  await manager.remove(book.bookId, false);
  assert.equal(await manager.store.load(`reading-${book.bookId}`), null);
});
test('remove refuses a compromised catalog file name before touching outside files', async (t) => {
  const { root, manager } = await setup(t);
  const book = await manager.importFile(fixture('chinese-utf8.txt'));
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'keep');
  const catalog = await manager.store.load('library');
  catalog.data.books[0].fileName = '../outside.txt';
  await manager.store.save('library', catalog.data, catalog.revision);
  await assert.rejects(manager.remove(book.bookId, false), {
    code: 'INVALID_BOOK',
  });
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});
test('S01-A5 rejects duplicate content', async (t) => {
  const { manager } = await setup(t);
  await manager.importFile(fixture('chinese-utf8.txt'));
  await assert.rejects(manager.importFile(fixture('chinese-utf8.txt')), {
    code: 'DUPLICATE',
  });
});
