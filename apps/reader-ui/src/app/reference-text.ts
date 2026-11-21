import type { ReaderChapter, ReadingPosition } from '@reader/storage-bridge';

/** Show only inert adapter text from the referenced paragraph. */
export function referenceText(chapter: ReaderChapter, target: ReadingPosition) {
  if (chapter.id !== target.chapterId) return '';
  const block = chapter.blocks[target.blockIndex];
  if (
    block === undefined ||
    !Number.isSafeInteger(target.offset) ||
    target.offset < 0 ||
    target.offset > block.length
  )
    return '';
  return block.replace(/￼/g, '[图片]');
}
