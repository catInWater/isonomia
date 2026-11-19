import type { CSSProperties } from 'react';
import type {
  ReaderImage,
  ReaderLink,
  ReadingPosition,
} from '@reader/storage-bridge';

export type ContentRun = {
  offset: number;
  length: number;
  text: string;
  image?: ReaderImage;
  target?: ReadingPosition;
};

export function contentRuns(
  text: string,
  images: ReaderImage[],
  links: ReaderLink[],
  startOffset = 0,
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
    return {
      offset,
      length,
      text: text.slice(offset - startOffset, offset - startOffset + length),
      ...(imageAt.has(offset) ? { image: imageAt.get(offset) } : {}),
      ...(link && link.offset <= offset ? { target: link.target } : {}),
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
