'use strict';

const { randomUUID } = require('node:crypto');
const {
  checkPosition,
  validPosition,
  ADAPTER_VERSION,
} = require('./reading.cjs');

const ANCHOR_SCHEMA_VERSION = 1;
const MAX_QUOTE = 16_000;
const CONTEXT = 32;
const compare = (a, b) => a.blockIndex - b.blockIndex || a.offset - b.offset;

function validRange(range) {
  return (
    range &&
    Object.keys(range).sort().join(',') === 'end,start' &&
    validPosition(range.start) &&
    validPosition(range.end) &&
    range.start.chapterId === range.end.chapterId &&
    compare(range.start, range.end) < 0
  );
}

// Canonical chapter text uses one LF between blocks and one U+FFFC per image.
function quote(chapter, { start, end }) {
  const parts = [];
  let length = 0;
  for (let i = start.blockIndex; i <= end.blockIndex; i++) {
    const block = chapter.blocks[i];
    const from = i === start.blockIndex ? start.offset : 0;
    const to = i === end.blockIndex ? end.offset : block.length;
    length += to - from + (i === start.blockIndex ? 0 : 1);
    if (length > MAX_QUOTE) return null;
    parts.push(block.slice(from, to));
  }
  return parts.join('\n');
}

function contextBefore(blocks, { blockIndex, offset }) {
  let text = blocks[blockIndex].slice(Math.max(0, offset - CONTEXT), offset);
  while (text.length < CONTEXT && blockIndex > 0) {
    const block = blocks[--blockIndex];
    text = `${block.slice(-CONTEXT)}\n${text}`.slice(-CONTEXT);
  }
  return text.replace(/^[\uDC00-\uDFFF]/, '');
}

function contextAfter(blocks, { blockIndex, offset }) {
  let text = blocks[blockIndex].slice(offset, offset + CONTEXT);
  while (text.length < CONTEXT && blockIndex < blocks.length - 1)
    text = `${text}\n${blocks[++blockIndex].slice(0, CONTEXT)}`.slice(
      0,
      CONTEXT,
    );
  return text.replace(/[\uD800-\uDBFF]$/, '');
}

function createAnchor(content, range, createdAt = new Date().toISOString()) {
  if (!validRange(range)) throw new Error('请选择同一章节内的正文。');
  const { book, chapters } = content;
  checkPosition(chapters, range.start);
  checkPosition(chapters, range.end);
  const chapter = chapters.find(({ id }) => id === range.start.chapterId);
  const start = { ...range.start };
  const end = { ...range.end };
  while (
    start.blockIndex < end.blockIndex &&
    start.offset === chapter.blocks[start.blockIndex].length
  ) {
    start.blockIndex++;
    start.offset = 0;
  }
  while (end.blockIndex > start.blockIndex && end.offset === 0) {
    end.blockIndex--;
    end.offset = chapter.blocks[end.blockIndex].length;
  }
  const exact = quote(chapter, { start, end });
  if (exact === null)
    throw new Error(`单条划线最多可选 ${MAX_QUOTE} 个字符，请缩短选区。`);
  if (!exact.replace(/[\s￼]/g, '')) throw new Error('请选择有文字的正文。');
  return {
    schemaVersion: ANCHOR_SCHEMA_VERSION,
    anchorId: `anchor-${randomUUID()}`,
    bookId: book.bookId,
    contentHash: book.contentHash,
    adapterVersion: ADAPTER_VERSION,
    format: book.format,
    source: {
      title: book.title,
      author: book.author,
      chapterTitle: chapter.title,
    },
    range: { start, end },
    exact,
    prefix: contextBefore(chapter.blocks, start),
    suffix: contextAfter(chapter.blocks, end),
    createdAt,
  };
}

const normalize = (text) => text.replace(/\s+/g, ' ');
const lost = (reason) => ({ status: 'lost', reason });

function normalizedOffsets(text, from, to) {
  let removed = 0;
  let start;
  for (const match of text.matchAll(/\s{2,}/g)) {
    const index = match.index - removed;
    if (start === undefined && from <= index) start = from + removed;
    if (to <= index) break;
    removed += match[0].length - 1;
  }
  return [start ?? from + removed, to + removed];
}

function positionAt(chapter, index, bias) {
  for (let blockIndex = 0; blockIndex < chapter.blocks.length; blockIndex++) {
    const end = chapter.blocks[blockIndex].length;
    if (index <= end) {
      // At an exact block end the offset still belongs to this block. The LF
      // itself is not stored as a position; quote reconstruction inserts it.
      if (
        index === end &&
        bias === 'start' &&
        blockIndex + 1 < chapter.blocks.length
      )
        return { chapterId: chapter.id, blockIndex: blockIndex + 1, offset: 0 };
      return { chapterId: chapter.id, blockIndex, offset: index };
    }
    index -= end + 1;
  }
  throw new Error('原文回退位置无效。');
}

/** Shared resolver for annotations, notes and search. It never modifies anchors. */
function createAnchorResolver(content) {
  if (!content) return () => lost('book-unavailable');
  const { book, chapters } = content;
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const indexed = new Map();
  const titles = new Map();
  for (const chapter of chapters)
    titles.set(chapter.title, (titles.get(chapter.title) || 0) + 1);
  return (anchor) => {
    if (anchor.bookId !== book.bookId) return lost('book-unavailable');
    if (anchor.schemaVersion !== ANCHOR_SCHEMA_VERSION)
      return lost('quote-not-found');
    if (
      anchor.contentHash === book.contentHash &&
      anchor.adapterVersion === ADAPTER_VERSION &&
      anchor.format === book.format &&
      validRange(anchor.range)
    ) {
      const { start, end } = anchor.range;
      const chapter = byId.get(start.chapterId);
      if (chapter) {
        try {
          checkPosition([chapter], start);
          checkPosition([chapter], end);
          if (quote(chapter, anchor.range) === anchor.exact)
            return { status: 'exact', range: anchor.range };
        } catch (error) {
          if (error.code !== 'INVALID_POSITION') throw error;
        }
      }
    }

    const needle = normalize(anchor.exact);
    if (!needle.trim()) return lost('quote-not-found');
    const prefix = normalize(anchor.prefix);
    const suffix = normalize(anchor.suffix);
    let best = null;
    let tied = false;
    for (const chapter of chapters) {
      if (!indexed.has(chapter)) {
        const text = chapter.blocks.join('\n');
        indexed.set(chapter, { text, normalized: normalize(text) });
      }
      const { normalized } = indexed.get(chapter);
      const chapterMatch =
        chapter.title === anchor.source.chapterTitle &&
        titles.get(chapter.title) === 1;
      let from = normalized.indexOf(needle);
      while (from !== -1) {
        const to = from + needle.length;
        const prefixMatch =
          prefix &&
          from >= prefix.length &&
          normalized.startsWith(prefix, from - prefix.length);
        const suffixMatch = suffix && normalized.startsWith(suffix, to);
        // An ordinal chapter ID or the old offset alone is not evidence after an edit.
        const score =
          2 * (Number(Boolean(prefixMatch)) + Number(Boolean(suffixMatch))) +
          Number(chapterMatch);
        if (!best || score > best.score) {
          best = { chapter, from, to, score };
          tied = false;
        } else if (score === best.score) tied = true;
        from = normalized.indexOf(needle, from + 1);
      }
    }
    if (!best || tied) return lost(tied ? 'ambiguous' : 'quote-not-found');
    const [from, to] = normalizedOffsets(
      indexed.get(best.chapter).text,
      best.from,
      best.to,
    );
    return {
      status: 'fallback',
      range: {
        start: positionAt(best.chapter, from, 'start'),
        end: positionAt(best.chapter, to, 'end'),
      },
    };
  };
}

function sourceLine(anchor) {
  const { title, author, chapterTitle } = anchor.source;
  return `${title} · ${author} · ${chapterTitle}`;
}

module.exports = { createAnchor, createAnchorResolver, validRange, sourceLine };
