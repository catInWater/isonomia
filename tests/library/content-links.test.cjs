'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zip } = require('../../tools/fixtures.cjs');
const {
  parseEpub,
  LibraryManager,
} = require('../../apps/reader/src/app/library/index.cjs');
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const {
  ReadingManager,
} = require('../../apps/reader/src/app/library/reading.cjs');

function book(chapters, extra = [], spine) {
  return zip([
    [
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    ],
    [
      'OEBPS/book.opf',
      `<package><metadata><title>合成引用测试</title></metadata><manifest>${chapters.map((_, index) => `<item id="c${index}" href="text/c${index}.xhtml" media-type="application/xhtml+xml"/>`).join('')}${extra.map(([name, , type], index) => `<item id="extra${index}" href="${name}" media-type="${type}"/>`).join('')}</manifest><spine>${(spine || chapters.map((_, index) => index)).map((index) => `<itemref idref="c${index}"/>`).join('')}</spine></package>`,
    ],
    ...chapters.map((body, index) => [
      `OEBPS/text/c${index}.xhtml`,
      `<html><head><link rel="stylesheet" href="../images.css"/></head><body>${body}</body></html>`,
    ]),
    ...extra.map(([name, bytes]) => [`OEBPS/${name}`, bytes]),
  ]);
}

test('chapter footnotes and return links preserve normalized text and precise destinations', () => {
  const parsed = parseEpub(
    book([
      '<p id="body">  前文 <a href="#note"><sup>[1]</sup></a> 后文</p><p>注释 <span id="note">内容</span> <a href="#body">返回</a></p>',
    ]),
  );
  const chapter = parsed.chapters[0];
  assert.deepEqual(chapter.blocks, ['前文 [1] 后文', '注释 内容 返回']);
  assert.deepEqual(chapter.links, [
    {
      blockIndex: 0,
      offset: 3,
      length: 3,
      target: { chapterId: 'chapter-1', blockIndex: 1, offset: 3 },
    },
    {
      blockIndex: 1,
      offset: 6,
      length: 2,
      target: { chapterId: 'chapter-1', blockIndex: 0, offset: 0 },
    },
  ]);
  assert.equal('resourcePath' in chapter, false);
  assert.equal('anchors' in chapter, false);
});

test('cross-chapter references decode fragments, while external and unauthorized targets remain inert', () => {
  const parsed = parseEpub(
    book([
      '<p><a href="c1.xhtml#%E6%B3%A8">注释</a> <a href="https://example.test/">远程</a> <a href="javascript:alert(1)">脚本</a> <a href="file:///private">文件</a> <a href="../../../private.xhtml">越界</a> <a href="c1.xhtml#missing">缺失</a> <a href="missing.xhtml#note">未声明</a> <a href="c1.xhtml?x=1#注">查询</a></p>',
      '<p id="注">跨章注释 <a href="c0.xhtml">返回正文</a></p>',
    ]),
  );
  assert.equal(parsed.chapters[0].links.length, 1);
  assert.deepEqual(parsed.chapters[0].links[0].target, {
    chapterId: 'chapter-2',
    blockIndex: 0,
    offset: 0,
  });
  assert.deepEqual(parsed.chapters[1].links[0].target, {
    chapterId: 'chapter-1',
    blockIndex: 0,
    offset: 0,
  });
  assert.match(
    parsed.chapters[0].blocks[0],
    /远程 脚本 文件 越界 缺失 未声明 查询/,
  );
  assert.doesNotMatch(
    JSON.stringify(parsed.chapters.map((chapter) => chapter.links)),
    /https:|file:|\.xhtml|href/,
  );
});

test('empty anchors and links spanning paragraph boundaries retain their targets', () => {
  const chapter = parseEpub(
    book([
      '<a name="start"/><div><a href="#end"><p>首段</p><p>次段</p></a></div><p id="end">末段 <a href="#start">返回</a></p><a id="tail"/><p><a href="#tail">尾锚点</a></p>',
    ]),
  ).chapters[0];
  assert.deepEqual(
    chapter.links.slice(0, 2).map((link) => link.target),
    [
      { chapterId: 'chapter-1', blockIndex: 2, offset: 0 },
      { chapterId: 'chapter-1', blockIndex: 2, offset: 0 },
    ],
  );
  assert.deepEqual(chapter.links[2].target, {
    chapterId: 'chapter-1',
    blockIndex: 0,
    offset: 0,
  });
  assert.deepEqual(chapter.links[3].target, {
    chapterId: 'chapter-1',
    blockIndex: 3,
    offset: 0,
  });
});

test('safe image sizing includes natural dimensions and inline1 stylesheet rules, not executable CSS', async () => {
  const png = parseEpub(
    await fs.readFile(path.join(__dirname, '../fixtures/epub-images.epub')),
  ).cover.bytes;
  const chapter = parseEpub(
    book(
      [
        '<p>字<img class="inline1" src="../pixel.png"/>形<img class="sized" src="../pixel.png"/></p><p><img src="../pixel.png" style="width:expression(alert(1));height:url(https://example.test/)"/></p>',
      ],
      [
        ['pixel.png', png, 'image/png'],
        [
          'images.css',
          '.inline1 { height: 1.2em; width: auto; margin-bottom: -0.1em; } .sized { width: 80px; height: 40px; } @import url(https://example.test/evil.css);',
          'text/css',
        ],
      ],
    ),
  ).chapters[0];
  const [glyph, sized, invalid] = chapter.images;
  assert.equal(glyph.inline, true);
  assert.equal(glyph.width, 1);
  assert.equal(glyph.height, 1);
  assert.equal(glyph.displayHeight, '1.2em');
  assert.equal(sized.inline, false);
  assert.equal(sized.displayWidth, '80px');
  assert.equal(sized.displayHeight, '40px');
  assert.equal(invalid.displayWidth, undefined);
  assert.equal(invalid.displayHeight, undefined);
  assert.doesNotMatch(
    JSON.stringify(chapter.images),
    /expression|example\.test|url\(/,
  );
});

test('image-budget fallbacks remap link spans and anchor offsets in repeated spine documents', async () => {
  const png = parseEpub(
    await fs.readFile(path.join(__dirname, '../fixtures/epub-images.epub')),
  ).cover.bytes;
  const parsed = parseEpub(
    book(
      [
        '<p><a href="#end"><img src="../pixel.png"/><img src="../pixel.png"/><img src="../pixel.png"/></a><span id="end">尾</span></p>',
      ],
      [['pixel.png', png, 'image/png']],
      Array(1366).fill(0),
    ),
  );
  const last = parsed.chapters.at(-1);
  assert.equal(last.images.length, 1);
  assert.equal(last.blocks[0], '￼[图片][图片]尾');
  assert.equal(last.links[0].length, 9);
  assert.deepEqual(last.links[0].target, {
    chapterId: last.id,
    blockIndex: 0,
    offset: 9,
  });
});

test('reading IPC returns only safe link positions and destinations remain valid reading positions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.epub');
  await fs.writeFile(
    source,
    book([
      '<p id="body"><a href="c1.xhtml#note">注释</a></p>',
      '<p id="note"><a href="c0.xhtml#body">返回</a></p>',
    ]),
  );
  const store = new DurableStore({
    root: path.join(root, 'data'),
    schemaVersion: 1,
    schemas: {
      1: (value) => value && typeof value === 'object' && !Array.isArray(value),
    },
  });
  const library = new LibraryManager({ root, store });
  const manager = new ReadingManager({ root, store, library });
  const imported = await library.importFile(source);
  const opened = await manager.openBook({ bookId: imported.bookId });
  const chapter = await manager.readChapter({
    bookId: imported.bookId,
    chapterId: 'chapter-1',
  });
  const target = chapter.links[0].target;
  await manager.saveReading({
    bookId: imported.bookId,
    contentHash: imported.contentHash,
    position: target,
    preferences: opened.preferences,
  });
  assert.deepEqual(
    (await manager.openBook({ bookId: imported.bookId })).position,
    target,
  );
  assert.doesNotMatch(
    JSON.stringify(chapter),
    /source\.epub|\.xhtml|href|resourcePath/,
  );
});
