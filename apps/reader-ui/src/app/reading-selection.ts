import type {
  ReaderChapter,
  ReadingPosition,
  ReadingRange,
} from '@reader/storage-bridge';
import { safeBoundary } from './pagination';

export function comparePositions(a: ReadingPosition, b: ReadingPosition) {
  return a.blockIndex - b.blockIndex || a.offset - b.offset;
}

export function selectionPreview(
  chapter: ReaderChapter,
  { start, end }: ReadingRange,
) {
  const limit = 400;
  let preview = '';
  for (let index = start.blockIndex; index <= end.blockIndex; index++) {
    const block = chapter.blocks[index];
    const from = index === start.blockIndex ? start.offset : 0;
    const to = index === end.blockIndex ? end.offset : block.length;
    if (index > start.blockIndex) preview += '\n';
    const take = Math.min(to, from + Math.max(0, limit - preview.length));
    preview += block.slice(from, safeBoundary(block, take));
    if (take < to || (preview.length >= limit && index < end.blockIndex))
      return preview + '…';
  }
  return preview;
}

/** Read native selection endpoints in adapter coordinates, not rendered text. */
export function readSelection(
  article: HTMLElement,
  chapter: ReaderChapter,
): ReadingRange | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (
    !article.contains(range.startContainer) ||
    !article.contains(range.endContainer)
  )
    return null;

  function boundary(
    node: Node,
    offset: number,
    end: boolean,
  ): ReadingPosition | null {
    const element = node instanceof Element ? node : node.parentElement;
    const run = element?.closest<HTMLElement>('[data-content-start]');
    function fromRun(item: HTMLElement, delta: number) {
      const blockIndex = Number(
        item.closest<HTMLElement>('[data-block-index]')?.dataset.blockIndex,
      );
      const block = chapter.blocks[blockIndex];
      if (block === undefined) return null;
      return {
        chapterId: chapter.id,
        blockIndex,
        offset: safeBoundary(block, Number(item.dataset.contentStart) + delta),
      };
    }
    if (run) {
      const length = Number(run.dataset.contentLength);
      // An EPUB image (or its visual fallback) occupies one place in the model.
      return fromRun(
        run,
        node.nodeType === Node.TEXT_NODE && node.parentElement === run
          ? Math.min(offset, length)
          : node === run
            ? offset > 0
              ? length
              : 0
            : end
              ? length
              : 0,
      );
    }
    // Native ranges can end between paragraph/inline elements (e.g. select all).
    const point = document.createRange();
    point.setStart(node, offset);
    point.collapse(true);
    const runs = Array.from(
      article.querySelectorAll<HTMLElement>('[data-content-start]'),
    );
    if (end) runs.reverse();
    for (const candidate of runs) {
      const edge = document.createRange();
      edge.selectNode(candidate);
      // Start boundaries compare to a run's start; end boundaries to its end.
      // Using the opposite edge includes adjacent, unselected inline runs.
      edge.collapse(!end);
      const order = point.compareBoundaryPoints(Range.START_TO_START, edge);
      if (end ? order >= 0 : order <= 0)
        return fromRun(
          candidate,
          end ? Number(candidate.dataset.contentLength) : 0,
        );
    }
    return null;
  }
  const start = boundary(range.startContainer, range.startOffset, false);
  const end = boundary(range.endContainer, range.endOffset, true);
  return start && end && comparePositions(start, end) < 0
    ? { start, end }
    : null;
}
