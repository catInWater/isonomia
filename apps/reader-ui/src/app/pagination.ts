import type { ReaderChapter } from '@reader/storage-bridge';

type PagePart = { blockIndex: number; start: number; text: string };
type ReaderPage = PagePart[];

export function safeBoundary(value: string, offset: number): number {
  const clamped = Math.max(0, Math.min(value.length, Math.floor(offset)));
  return clamped > 0 &&
    clamped < value.length &&
    /[\uD800-\uDBFF]/.test(value[clamped - 1]) &&
    /[\uDC00-\uDFFF]/.test(value[clamped])
    ? clamped - 1
    : clamped;
}

export function makePages(
  chapter: ReaderChapter,
  capacity: number,
): ReaderPage[] {
  const pages: ReaderPage[] = [];
  let page: ReaderPage = [];
  let used = 0;
  const finishPage = () => {
    if (page.length) pages.push(page);
    page = [];
    used = 0;
  };
  const appendText = (
    block: string,
    blockIndex: number,
    from: number,
    to: number,
  ) => {
    let start = from;
    while (start < to) {
      let available = Math.floor(capacity - used - (page.length ? 32 : 0));
      if (available < 1 && page.length) {
        finishPage();
        available = Math.floor(capacity);
      }
      available = Math.max(1, available);
      let end = safeBoundary(block, Math.min(to, start + available));
      if (end <= start) end = Math.min(to, start + Math.max(2, available));
      if (end < to) {
        const boundary = block.lastIndexOf(' ', end);
        if (boundary > start + Math.floor(available * 0.55)) end = boundary + 1;
      }
      page.push({ blockIndex, start, text: block.slice(start, end) });
      used += end - start + 32;
      start = end;
      if (start < to || used >= capacity) finishPage();
    }
  };
  chapter.blocks.forEach((block, blockIndex) => {
    if (!block.length) return;
    const blockImages = (chapter.images || [])
      .filter((image) => image.blockIndex === blockIndex && !image.inline)
      .sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const image of blockImages) {
      if (image.offset < cursor || block[image.offset] !== '￼') continue;
      appendText(block, blockIndex, cursor, image.offset);
      finishPage();
      pages.push([{ blockIndex, start: image.offset, text: '￼' }]);
      cursor = image.offset + 1;
    }
    appendText(block, blockIndex, cursor, block.length);
    if (used >= capacity) finishPage();
  });
  finishPage();
  return pages.length ? pages : [[]];
}
