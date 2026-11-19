'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  makePages,
  safeBoundary,
} = require('../../apps/reader-ui/src/app/pagination.ts');

const image = (offset, inline = false) => ({
  blockIndex: 0,
  offset,
  inline,
  src: 'data:image/png;base64,AA==',
  alt: '插图',
});

test('illustrations occupy separate pages without losing surrounding text or positions', () => {
  const chapter = {
    id: 'chapter-1',
    title: '插图',
    blocks: ['前文￼后文￼尾声', '下一段'],
    images: [image(2), image(5)],
  };
  const pages = makePages(chapter, 400);
  assert.equal(pages.length, 5);
  assert.deepEqual(pages[1], [{ blockIndex: 0, start: 2, text: '￼' }]);
  assert.deepEqual(pages[3], [{ blockIndex: 0, start: 5, text: '￼' }]);
  for (const [blockIndex, block] of chapter.blocks.entries()) {
    const parts = pages.flat().filter((part) => part.blockIndex === blockIndex);
    assert.equal(parts.map((part) => part.text).join(''), block);
    for (const part of parts) {
      assert.equal(
        block.slice(part.start, part.start + part.text.length),
        part.text,
      );
    }
  }
});

test('inline glyphs stay in text pages, and consecutive standalone images do not share a page', () => {
  const inline = makePages(
    { id: 'chapter-1', title: '', blocks: ['前￼后'], images: [image(1, true)] },
    400,
  );
  assert.deepEqual(inline, [[{ blockIndex: 0, start: 0, text: '前￼后' }]]);
  const standalone = makePages(
    {
      id: 'chapter-1',
      title: '',
      blocks: ['￼￼'],
      images: [image(0), image(1)],
    },
    400,
  );
  assert.equal(standalone.length, 2);
  assert.ok(
    standalone.every((page) => page.length === 1 && page[0].text === '￼'),
  );
});

test('pagination retains long text and never splits surrogate pairs', () => {
  const text = '前😀后'.repeat(400);
  const pages = makePages({ id: 'chapter-1', title: '', blocks: [text] }, 403);
  assert.equal(
    pages
      .flat()
      .map((part) => part.text)
      .join(''),
    text,
  );
  for (const part of pages.flat()) {
    assert.doesNotMatch(part.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  assert.equal(safeBoundary('前😀后', 2), 1);
});
