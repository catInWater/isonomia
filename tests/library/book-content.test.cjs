'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const postcss = require('postcss');
const {
  contentRuns,
  bookImageStyle,
} = require('../../apps/reader-ui/src/app/book-content.ts');
const {
  makePages,
  pageForPosition,
} = require('../../apps/reader-ui/src/app/pagination.ts');
const {
  imageRules,
  imageLayout,
} = require('../../apps/reader/src/app/library/image-layout.cjs');

const target = { chapterId: 'chapter-2', blockIndex: 3, offset: 7 };
const image = {
  blockIndex: 0,
  offset: 2,
  src: 'data:image/png;base64,AA==',
  alt: '字',
  inline: true,
  width: 40,
  height: 50,
};

test('linked content runs retain text, image links and clipped links across paginated slices', () => {
  const text = '前文￼注释后文';
  const link = { blockIndex: 0, offset: 1, length: 4, target };
  const runs = contentRuns(text, [image], [link]);
  assert.equal(runs.map((run) => run.text).join(''), text);
  assert.deepEqual(
    runs.filter((run) => run.target).map((run) => run.text),
    ['文', '￼', '注释'],
  );
  assert.deepEqual(runs.find((run) => run.image).target, target);
  const slice = contentRuns(text.slice(3, 6), [image], [link], 3);
  assert.equal(slice[0].text, '注释');
  assert.deepEqual(slice[0].target, target);
  assert.equal(slice[0].offset, 3);
  assert.equal(slice[1].target, undefined);
  assert.equal(contentRuns('', [], []).length, 0);
});

test('content decorations split runs while preserving link targets and page offsets', () => {
  const runs = contentRuns(
    '甲乙丙丁戊',
    [],
    [{ blockIndex: 0, offset: 1, length: 3, target }],
    0,
    [
      { offset: 2, length: 2, highlightId: 'highlight-a', color: 'green' },
      { offset: 3, length: 1, emphasis: 'jump' },
    ],
  );
  assert.deepEqual(
    runs.map(({ offset, text, target: linked, highlight, emphasis }) => ({
      offset,
      text,
      linked: Boolean(linked),
      highlight: highlight?.highlightId,
      color: highlight?.color,
      emphasis,
    })),
    [
      {
        offset: 0,
        text: '甲',
        linked: false,
        highlight: undefined,
        color: undefined,
        emphasis: undefined,
      },
      {
        offset: 1,
        text: '乙',
        linked: true,
        highlight: undefined,
        color: undefined,
        emphasis: undefined,
      },
      {
        offset: 2,
        text: '丙',
        linked: true,
        highlight: 'highlight-a',
        color: 'green',
        emphasis: undefined,
      },
      {
        offset: 3,
        text: '丁',
        linked: true,
        highlight: 'highlight-a',
        color: 'green',
        emphasis: 'jump',
      },
      {
        offset: 4,
        text: '戊',
        linked: false,
        highlight: undefined,
        color: undefined,
        emphasis: undefined,
      },
    ],
  );
  const slice = contentRuns('丙丁', [], [], 2, [
    { offset: 2, length: 2, highlightId: 'highlight-a', color: 'green' },
    { offset: 3, length: 1, emphasis: 'jump' },
  ]);
  assert.deepEqual(
    slice.map(({ offset, text, emphasis }) => ({ offset, text, emphasis })),
    [
      { offset: 2, text: '丙', emphasis: undefined },
      { offset: 3, text: '丁', emphasis: 'jump' },
    ],
  );
});

test('page lookup sends an anchor on a page boundary to the following page, not the previous page', () => {
  const chapter = {
    id: 'chapter-1',
    title: '',
    blocks: ['前文￼后文'],
    images: [{ ...image, inline: false }],
  };
  const pages = makePages(chapter, 400);
  assert.equal(
    pageForPosition(
      pages,
      { chapterId: chapter.id, blockIndex: 0, offset: 2 },
      chapter.blocks,
    ),
    1,
  );
  assert.equal(
    pageForPosition(
      pages,
      { chapterId: chapter.id, blockIndex: 0, offset: 3 },
      chapter.blocks,
    ),
    2,
  );
  assert.equal(
    pageForPosition(
      pages,
      { chapterId: chapter.id, blockIndex: 0, offset: 5 },
      chapter.blocks,
    ),
    2,
  );
});

test('image layout uses constrained sizing, natural aspect ratio and inline glyph heights', () => {
  assert.deepEqual(bookImageStyle(image), {
    width: 'auto',
    height: '1em',
    aspectRatio: '40 / 50',
  });
  assert.deepEqual(
    bookImageStyle({ ...image, inline: false, displayWidth: '80px' }),
    { width: '80px', height: 'auto', aspectRatio: '40 / 50' },
  );
  assert.equal(
    bookImageStyle({ ...image, displayHeight: '1.2em' }).height,
    '1.2em',
  );
  assert.equal(
    bookImageStyle({
      ...image,
      displayWidth: 'url(https://example.test/)',
      displayHeight: '999999em',
    }).height,
    '1em',
  );
  const rules = imageRules(
    '@media screen { .inline1 { height: 50em; } } img { width: auto; } .inline1 { height: 1.1em; } #glyph { height: 1.3em; }',
  );
  const layout = imageLayout(
    { class: 'inline1', id: 'glyph', style: 'height:1.4em' },
    rules,
    { width: 40, height: 50 },
  );
  assert.equal(layout.inline, true);
  assert.equal(layout.displayHeight, '1.4em');
});

test('cover artwork cannot expand the uniform shelf frame or stretch its aspect ratio', () => {
  const css = postcss.parse(
    fs.readFileSync(
      require.resolve('../../apps/reader-ui/src/app/app.module.css'),
      'utf8',
    ),
  );
  const declarations = (selector) => {
    const rule = css.nodes.find(
      (node) => node.type === 'rule' && node.selector === selector,
    );
    return Object.fromEntries(
      rule.nodes
        .filter((node) => node.type === 'decl')
        .map((node) => [node.prop, node.value]),
    );
  };
  const frame = declarations('.cover');
  const artwork = declarations('.cover img');
  assert.equal(frame['aspect-ratio'], '3 / 4');
  assert.equal(frame.overflow, 'hidden');
  assert.equal(frame.position, 'relative');
  assert.equal(artwork.position, 'absolute');
  assert.equal(artwork.width, '100%');
  assert.equal(artwork.height, '100%');
  assert.equal(artwork['object-fit'], 'contain');
  assert.equal(declarations('.list .cover').width, '44px');
});
