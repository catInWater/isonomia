import type { CSSProperties } from 'react';
import type {
  HighlightColor,
  ReaderImage,
  ReaderLink,
  ReadingPosition,
} from '@reader/storage-bridge';

export type ContentDecoration = {
  offset: number;
  length: number;
  highlightId?: string;
  color?: HighlightColor;
  emphasis?: 'preview' | 'jump';
};

export type ContentRun = {
  offset: number;
  length: number;
  text: string;
  image?: ReaderImage;
  target?: ReadingPosition;
  highlight?: ContentDecoration;
  emphasis?: ContentDecoration['emphasis'];
};

export function contentRuns(
  text: string,
  images: ReaderImage[],
  links: ReaderLink[],
  startOffset = 0,
  decorations: ContentDecoration[] = [],
): ContentRun[] {
  const endOffset = startOffset + text.length;
  const points = new Set([startOffset, endOffset]);
  const imageAt = new Map<number, ReaderImage>();
  for (const image of images) {
    if (
      image.offset < startOffset ||
      image.offset >= endOffset ||
      text[image.offset - startOffset] !== '￼'
    )
      continue;
    imageAt.set(image.offset, image);
    points.add(image.offset);
    points.add(image.offset + 1);
  }
  const visibleLinks = links
    .filter(
      (link) =>
        link.length > 0 &&
        link.offset < endOffset &&
        link.offset + link.length > startOffset,
    )
    .sort((a, b) => a.offset - b.offset);
  for (const link of visibleLinks) {
    points.add(Math.max(startOffset, link.offset));
    points.add(Math.min(endOffset, link.offset + link.length));
  }
  const visibleDecorations = decorations.filter(
    ({ offset, length }) =>
      length > 0 && offset < endOffset && offset + length > startOffset,
  );
  for (const { offset, length } of visibleDecorations) {
    points.add(Math.max(startOffset, offset));
    points.add(Math.min(endOffset, offset + length));
  }
  const boundaries = [...points].sort((a, b) => a - b);
  let linkIndex = 0;
  return boundaries.slice(0, -1).map((offset, index) => {
    while (
      linkIndex < visibleLinks.length &&
      visibleLinks[linkIndex].offset + visibleLinks[linkIndex].length <= offset
    )
      linkIndex++;
    const link = visibleLinks[linkIndex];
    const length = boundaries[index + 1] - offset;
    const covers = (decoration: ContentDecoration) =>
      decoration.offset <= offset &&
      offset < decoration.offset + decoration.length;
    let highlight: ContentDecoration | undefined;
    let emphasis: ContentDecoration['emphasis'];
    for (const decoration of visibleDecorations) {
      if (!covers(decoration)) continue;
      if (decoration.highlightId) highlight = decoration;
      if (decoration.emphasis) emphasis = decoration.emphasis;
    }
    return {
      offset,
      length,
      text: text.slice(offset - startOffset, offset - startOffset + length),
      ...(imageAt.has(offset) ? { image: imageAt.get(offset) } : {}),
      ...(link && link.offset <= offset ? { target: link.target } : {}),
      ...(highlight ? { highlight } : {}),
      ...(emphasis ? { emphasis } : {}),
    };
  });
}

function safeLength(value: string | undefined) {
  const match = /^(\d+(?:\.\d+)?)(px|em|rem|%)$/.exec(value || '');
  if (!match) return undefined;
  const amount = Number(match[1]);
  const limit = match[2] === '%' ? 100 : match[2] === 'px' ? 16384 : 64;
  return amount > 0 && amount <= limit ? value : undefined;
}

export function bookImageStyle(image: ReaderImage): CSSProperties {
  return {
    width: safeLength(image.displayWidth) || 'auto',
    height: safeLength(image.displayHeight) || (image.inline ? '1em' : 'auto'),
    ...(image.width && image.height && image.width > 0 && image.height > 0
      ? { aspectRatio: `${image.width} / ${image.height}` }
      : {}),
  };
}
