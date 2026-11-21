'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  referenceText,
} = require('../../apps/reader-ui/src/app/reference-text.ts');
const chapter = {
  id: 'chapter-2',
  title: '注释',
  blocks: ['前一段', '完整注释￼末尾', '不能混入下一段'],
};
test('reference preview returns exactly its paragraph, preserving inert text and image fallbacks', () => {
  assert.equal(
    referenceText(chapter, { chapterId: chapter.id, blockIndex: 1, offset: 2 }),
    '完整注释[图片]末尾',
  );
  assert.deepEqual(chapter.blocks, [
    '前一段',
    '完整注释￼末尾',
    '不能混入下一段',
  ]);
});
test('reference preview fails closed for mismatched chapters or invalid destinations', () => {
  for (const target of [
    { chapterId: 'chapter-1', blockIndex: 1, offset: 0 },
    { chapterId: chapter.id, blockIndex: 9, offset: 0 },
    { chapterId: chapter.id, blockIndex: 1, offset: -1 },
    { chapterId: chapter.id, blockIndex: 1, offset: 500 },
    { chapterId: chapter.id, blockIndex: 1, offset: NaN },
  ])
    assert.equal(referenceText(chapter, target), '');
});
