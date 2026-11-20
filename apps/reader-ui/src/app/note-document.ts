import type { NoteDocument, SourceAnchor } from '@reader/storage-bridge';

const allowed = new Set([
  'P',
  'DIV',
  'H2',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'STRONG',
  'B',
  'BR',
]);
const discarded = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'SVG',
  'MATH',
  'TEMPLATE',
]);
export const escapeNoteText = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function sourceMarkup(anchor: SourceAnchor): string {
  const source = `${anchor.source.title} · ${anchor.source.author} · ${anchor.source.chapterTitle}`;
  return `<span data-note-source="${escapeNoteText(anchor.anchorId)}" contenteditable="false"><span>${escapeNoteText(anchor.exact.replace(/￼/g, '[图片]'))}</span><button type="button" data-note-jump="${escapeNoteText(anchor.anchorId)}" aria-label="定位引用原文">${escapeNoteText(source)}</button></span>`;
}

/** No URLs, arbitrary attributes or editable copies of source snapshots survive. */
export function sanitizeNoteDocument(
  input: string,
  sources: SourceAnchor[] = [],
): string {
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  const byId = new Map(sources.map((anchor) => [anchor.anchorId, anchor]));
  const clean = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return escapeNoteText(node.textContent || '');
    if (!(node instanceof HTMLElement) || discarded.has(node.tagName))
      return '';
    const anchor = byId.get(node.getAttribute('data-note-source') || '');
    if (anchor) return sourceMarkup(anchor);
    const children = Array.from(node.childNodes).map(clean).join('');
    if (!allowed.has(node.tagName)) return children;
    const tag = node.tagName === 'DIV' ? 'p' : node.tagName.toLowerCase();
    return tag === 'br' ? '<br>' : `<${tag}>${children}</${tag}>`;
  };
  return Array.from(parsed.body.childNodes).map(clean).join('');
}

export function parseNoteDocument(input: string): NoteDocument {
  let value: NoteDocument;
  if (input.trimStart().startsWith('{')) {
    value = JSON.parse(input) as NoteDocument;
    if (
      value.schemaVersion !== 1 ||
      typeof value.html !== 'string' ||
      !Array.isArray(value.sources) ||
      !Array.isArray(value.importedAnnotationIds)
    ) {
      throw new Error('笔记文档版本或格式不受支持，原记录未更改。');
    }
  } else
    value = {
      schemaVersion: 1,
      html: input,
      sources: [],
      importedAnnotationIds: [],
    };
  return { ...value, html: sanitizeNoteDocument(value.html, value.sources) };
}

export function serializeNoteDocument(value: NoteDocument): string {
  return JSON.stringify({
    ...value,
    html: sanitizeNoteDocument(value.html, value.sources),
  });
}
