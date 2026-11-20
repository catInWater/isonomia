'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  createAnchor,
  createAnchorResolver,
  sourceLine,
} = require('../../apps/reader/src/app/library/anchors.cjs');
const {
  parseEpub,
  parseTxt,
} = require('../../apps/reader/src/app/library/index.cjs');
const { makePages } = require('../../apps/reader-ui/src/app/pagination.ts');
const { epub } = require('../../tools/fixtures.cjs');

const createdAt = '2026-01-02T03:04:05.000Z';
const position = (chapter, blockIndex, offset) => ({
  chapterId: `chapter-${chapter}`,
  blockIndex,
  offset,
});
const range = (chapter, startBlock, start, endBlock, end) => ({
  start: position(chapter, startBlock, start),
  end: position(chapter, endBlock, end),
});
function parsedContent(format, bytes) {
  const { chapters, title, author } = (format === 'txt' ? parseTxt : parseEpub)(
    bytes,
  );
  return {
    book: {
      bookId: `book-${(format === 'txt' ? 'a' : 'b').repeat(32)}`,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      format,
      title: title || '合成江岸',
      author: author || '测试作者',
    },
    chapters,
  };
}
const txtContent = (text) => parsedContent('txt', Buffer.from(text));

// Offsets and expected quotes are fixed independently of the parsers and paginator.
const canonical = [
  {
    content: txtContent(
      [
        '第一章 雨巷',
        '开门前，风又起了。雨落下。',
        '穿过院子，风又起了。天还亮。',
        '牌子写着：甲  乙\t丙。',
        '桥上🚉仍有灯。船已靠岸。',
        '第二章 江岸',
        `${'潮'.repeat(396)}窗边🚉仍有灯。${'沙'.repeat(420)}`,
        '远处，风又起了。',
        '此处换行',
        '还有下半句。',
      ].join('\n'),
    ),
    selections: [
      ['first repetition', range(1, 0, 4, 0, 9), '风又起了。'],
      ['second repetition', range(1, 1, 5, 1, 10), '风又起了。'],
      ['other chapter', range(2, 1, 3, 1, 8), '风又起了。'],
      ['chapter start', range(1, 0, 0, 0, 4), '开门前，'],
      ['paragraph end', range(1, 1, 10, 1, 14), '天还亮。'],
      ['internal spaces and tab', range(1, 2, 5, 2, 12), '甲  乙\t丙。'],
      ['one surrogate pair', range(1, 3, 2, 3, 4), '🚉'],
      ['text around surrogate pair', range(1, 3, 1, 3, 8), '上🚉仍有灯。'],
      ['two paragraphs', range(1, 0, 9, 1, 5), '雨落下。\n穿过院子，'],
      [
        'page boundary inside paragraph',
        range(2, 0, 396, 0, 404),
        '窗边🚉仍有灯。',
      ],
      ['three paragraphs', range(2, 1, 6, 3, 3), '了。\n此处换行\n还有下'],
    ],
  },
  {
    content: parsedContent(
      'epub',
      epub({
        images: true,
        body: [
          '<p>院外。<img src="images/pixel.png" alt="灯塔"/>潮水又涨了。</p>',
          '<p>甲 \n 乙&#160;丙，丁。夜深。</p>',
          '<p>潮水又涨了。夜未眠。</p>',
          '<p>灯灭前，<em>还听见🚢</em>靠岸。</p>',
        ].join(''),
      }),
    ),
    selections: [
      ['after image', range(1, 0, 4, 0, 10), '潮水又涨了。'],
      ['repetition without image', range(1, 2, 0, 2, 6), '潮水又涨了。'],
      ['text across image', range(1, 0, 2, 0, 5), '。￼潮'],
      ['XHTML whitespace', range(1, 1, 0, 1, 8), '甲 乙 丙，丁。'],
      ['non-BMP at markup boundary', range(1, 3, 7, 3, 9), '🚢'],
      ['text across inline markup', range(1, 3, 4, 3, 12), '还听见🚢靠岸。'],
      ['newline and trailing space', range(1, 0, 8, 1, 4), '了。\n甲 乙 '],
      ['quoted across blocks', range(1, 2, 6, 3, 4), '夜未眠。\n灯灭前，'],
      ['after normalized whitespace', range(1, 1, 8, 1, 11), '夜深。'],
    ],
  },
];

// Project an adapter range onto the rendered page parts, not the source blocks.
function pageQuote(pages, { start, end }) {
  const blocks = Array(end.blockIndex - start.blockIndex + 1).fill('');
  let pagesTouched = 0;
  for (const page of pages) {
    let selected = false;
    for (const part of page) {
      const index = part.blockIndex;
      if (index < start.blockIndex || index > end.blockIndex) continue;
      const from = index === start.blockIndex ? start.offset : 0;
      const to = index === end.blockIndex ? end.offset : Infinity;
      const lo = Math.max(0, from - part.start);
      const hi = Math.min(part.text.length, to - part.start);
      if (lo >= hi) continue;
      blocks[index - start.blockIndex] += part.text.slice(lo, hi);
      selected = true;
    }
    if (selected) pagesTouched++;
  }
  return { exact: blocks.join('\n'), pagesTouched };
}

test('S03-A1/A2: all 20 fixed TXT and EPUB selections survive repagination', () => {
  const capacities = [400, 560, 1024];
  const anchorIds = new Set();
  for (const { content, selections } of canonical) {
    const { book, chapters } = content;
    const resolve = createAnchorResolver(content);
    const layouts = new Map(
      chapters.map((chapter) => [
        chapter.id,
        capacities.map((capacity) => makePages(chapter, capacity)),
      ]),
    );
    for (const [label, selection, exact] of selections) {
      const chapter = chapters.find(
        ({ id }) => id === selection.start.chapterId,
      );
      const anchor = createAnchor(content, selection, createdAt);
      assert.match(anchor.anchorId, /^anchor-.+/);
      anchorIds.add(anchor.anchorId);
      assert.equal(anchor.schemaVersion, 1, label);
      assert.ok(
        Number.isSafeInteger(anchor.adapterVersion) &&
          anchor.adapterVersion > 0,
      );
      assert.equal(anchor.bookId, book.bookId, label);
      assert.equal(anchor.contentHash, book.contentHash, label);
      assert.equal(anchor.format, book.format, label);
      assert.deepEqual(
        anchor.source,
        {
          title: book.title,
          author: book.author,
          chapterTitle: chapter.title,
        },
        label,
      );
      assert.deepEqual(anchor.range, selection, label);
      assert.equal(anchor.exact, exact, label);
      assert.equal(anchor.createdAt, createdAt, label);

      for (const [index, pages] of layouts.get(chapter.id).entries()) {
        const atCapacity = `${label} at capacity ${capacities[index]}`;
        const result = resolve(anchor);
        assert.deepEqual(
          result,
          { status: 'exact', range: selection },
          atCapacity,
        );
        const rendered = pageQuote(pages, result.range);
        assert.equal(rendered.exact, exact, atCapacity);
        if (label === 'page boundary inside paragraph') {
          assert.equal(rendered.pagesTouched > 1, index === 0, atCapacity);
        }
      }
    }
  }
  assert.equal(anchorIds.size, 20);
});

test('source snapshots retain nearby context and a human-readable citation', () => {
  const content = txtContent('第一章 渡口\n前一段。\n左「引文。」右\n后一段。');
  const anchor = createAnchor(content, range(1, 1, 2, 1, 5), createdAt);
  assert.equal(anchor.exact, '引文。');
  assert.equal(anchor.prefix, '前一段。\n左「');
  assert.equal(anchor.suffix, '」右\n后一段。');
  assert.equal(sourceLine(anchor), '合成江岸 · 测试作者 · 第一章 渡口');
});

test('anchor creation rejects cross-chapter, empty and invalid UTF-16 ranges', () => {
  const source = canonical[0].content;
  for (const [label, selection] of [
    ['cross-chapter', { start: position(1, 0, 0), end: position(2, 0, 1) }],
    ['collapsed', range(1, 0, 2, 0, 2)],
    ['reversed', range(1, 0, 4, 0, 2)],
    ['missing block', range(1, 0, 0, 99, 1)],
    ['out of bounds', range(1, 0, 0, 0, 14)],
    ['surrogate split', range(1, 3, 2, 3, 3)],
    ['only whitespace', range(1, 2, 6, 2, 8)],
  ]) {
    assert.throws(() => createAnchor(source, selection, createdAt), label);
  }
  assert.throws(() =>
    createAnchor(canonical[1].content, range(1, 0, 3, 0, 4), createdAt),
  );
});

test('S03-A3: fallback maps normalized whitespace to the shifted UTF-16 range without rewriting the quote', () => {
  const original = txtContent(
    '第一章 渡口\n前言：她说「候船  到此」；\n风歇了！其余照旧。',
  );
  const anchor = createAnchor(original, range(1, 0, 6, 1, 4), createdAt);
  assert.equal(anchor.exact, '候船  到此」；\n风歇了！');
  const before = structuredClone(anchor);
  const revised = txtContent(
    '第一章 序\n新增目录。\n第二章 渡口\n版本脚注。\n' +
      '移  位。前言：她说「候船\t到此」；　 风歇了！其余照旧。',
  );
  const resolved = createAnchorResolver(revised)(anchor);
  assert.deepEqual(resolved, {
    status: 'fallback',
    range: range(2, 1, 11, 1, 24),
  });
  assert.equal(
    createAnchor(revised, resolved.range, createdAt).exact,
    '候船\t到此」；　 风歇了！',
  );
  assert.deepEqual(anchor, before);
});

test('a stale range cannot count as exact even if the book hash still matches', () => {
  const content = txtContent('第一章 渡口\n左岸。右岸。');
  const selection = range(1, 0, 3, 0, 6);
  const anchor = createAnchor(content, selection, createdAt);
  const resolve = createAnchorResolver(content);
  for (const staleRange of [range(1, 0, 0, 0, 3), range(1, 0, 4, 0, 7)]) {
    assert.deepEqual(resolve({ ...anchor, range: staleRange }), {
      status: 'fallback',
      range: selection,
    });
  }
});

test('S03-A3: context can disambiguate repeats, but a tied old offset is not evidence', () => {
  const line = `${'前'.repeat(40)}「风又起了。」${'后'.repeat(40)}`;
  const decoy = `${'甲'.repeat(40)}「风又起了。」${'乙'.repeat(40)}`;
  const anchor = createAnchor(
    txtContent(`第一章 渡口\n${line}`),
    range(1, 0, 41, 0, 46),
    createdAt,
  );
  const shifted = txtContent(`第一章 渡口\n${decoy}\n${line}`);
  assert.deepEqual(createAnchorResolver(shifted)(anchor), {
    status: 'fallback',
    range: range(1, 1, 41, 1, 46),
  });
  const repeated = txtContent(`第一章 渡口\n${line}\n${line}`);
  assert.deepEqual(createAnchorResolver(repeated)(anchor), {
    status: 'lost',
    reason: 'ambiguous',
  });
});

test('S03-A3: deleted quotes and unavailable books have distinct lost reasons', () => {
  const original = txtContent('第一章 渡口\n潮水又涨了！');
  const anchor = createAnchor(original, range(1, 0, 0, 0, 6), createdAt);
  const edited = txtContent('第一章 渡口\n浪又落了！');
  assert.deepEqual(createAnchorResolver(edited)(anchor), {
    status: 'lost',
    reason: 'quote-not-found',
  });
  const otherBook = {
    ...original,
    book: { ...original.book, bookId: `book-${'c'.repeat(32)}` },
  };
  for (const content of [null, otherBook]) {
    assert.deepEqual(createAnchorResolver(content)(anchor), {
      status: 'lost',
      reason: 'book-unavailable',
    });
  }
  assert.equal(anchor.exact, '潮水又涨了！');
});
