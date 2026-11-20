const allowed = new Set([
  'P',
  'H2',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'STRONG',
  'B',
  'BR',
]);

export function sanitizeNoteDocument(input: string): string {
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  const clean = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return (node.textContent || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    if (!(node instanceof HTMLElement)) return '';
    const children = Array.from(node.childNodes).map(clean).join('');
    if (!allowed.has(node.tagName)) return children;
    const tag = node.tagName.toLowerCase();
    return tag === 'br' ? '<br>' : `<${tag}>${children}</${tag}>`;
  };
  return Array.from(parsed.body.childNodes).map(clean).join('');
}
