'use strict';
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { SaxesParser } = require('saxes');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_EPUB';
  throw error;
}
function xml(bytes) {
  const root = { name: '', attrs: {}, children: [] };
  const stack = [root];
  let nodes = 0;
  const parser = new SaxesParser();
  parser.on('doctype', (declaration) => {
    // EPUB XHTML commonly uses an external XHTML doctype; saxes never fetches it.
    // Internal subsets could define entities and are rejected outright.
    if (declaration.includes('[') || declaration.includes(']'))
      invalid('EPUB 不支持内部 DTD 实体。');
  });
  parser.on('error', () => invalid('EPUB XML 结构无效。'));
  parser.on('opentag', ({ name, attributes }) => {
    if (++nodes > 100_000 || stack.length > 128)
      invalid('EPUB XML 超过结构限制。');
    const node = {
      name: name.toLowerCase().split(':').at(-1),
      attrs: attributes,
      children: [],
    };
    stack.at(-1).children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => stack.pop());
  const addText = (value) => {
    if (++nodes > 100_000) invalid('EPUB XML 超过结构限制。');
    stack.at(-1).children.push(value);
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('EPUB XML 编码无效。');
  }
  parser.write(source).close();
  return root;
}
function all(node, name) {
  const result = [];
  function visit(item) {
    if (typeof item === 'string') return;
    if (item.name === name) result.push(item);
    item.children.forEach(visit);
  }
  visit(node);
  return result;
}
function text(node) {
  return (
    node?.children
      .map((child) => (typeof child === 'string' ? child : text(child)))
      .join('') || ''
  );
}
function resource(base, href) {
  if (typeof href !== 'string' || !href || /[\\\u0000-\u001f?#]/.test(href))
    invalid('EPUB 资源路径无效。');
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    invalid('EPUB 资源路径编码无效。');
  }
  if (/[\\\u0000-\u001f?#:]/.test(decoded) || decoded.startsWith('/'))
    invalid('EPUB 资源路径无效。');
  const name = path.posix.normalize(
    path.posix.join(path.posix.dirname(base), decoded),
  );
  if (name === '..' || name.startsWith('../')) invalid('EPUB 资源路径越界。');
  return name;
}
function blocksFromDocument(document) {
  const blocks = [];
  let current = '';
  const flush = () => {
    const value = current.replace(/\s+/g, ' ').trim();
    if (value) blocks.push(value);
    current = '';
  };
  const omitted = new Set([
    'head',
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'form',
    'audio',
    'video',
    'template',
  ]);
  const boundary =
    /^(p|div|section|article|h[1-6]|li|blockquote|pre|tr|br|hr)$/;
  function walk(node) {
    if (typeof node === 'string') {
      current += node;
      return;
    }
    if (omitted.has(node.name)) return;
    if (boundary.test(node.name)) flush();
    if (node.name === 'img')
      current += node.attrs.alt ? `[${node.attrs.alt}]` : '[图片]';
    else node.children.forEach(walk);
    if (boundary.test(node.name)) flush();
  }
  const body = all(document, 'body')[0];
  if (!body) invalid('EPUB 缺少章节正文。');
  walk(body);
  flush();
  return blocks.length ? blocks : [''];
}
function parseEpub(buffer) {
  if (buffer.length > MAX_BYTES) invalid('EPUB 超过 32 MiB 大小限制。');
  const seen = new Set();
  const files = Object.create(null);
  const signature = 0x06054b50;
  let end = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 65_557);
    offset--
  ) {
    if (
      buffer.readUInt32LE(offset) === signature &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalid('EPUB ZIP 目录无效。');
  const disk = buffer.readUInt16LE(end + 4);
  const directoryDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8);
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    disk ||
    directoryDisk ||
    diskEntries !== entries ||
    entries > 2048 ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize !== end
  )
    invalid('EPUB ZIP 目录超出限制。');
  let total = 0;
  let cursor = directoryOffset;
  const ranges = [];
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
      invalid('EPUB ZIP 条目无效。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const centralName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      startDisk ||
      localOffset === 0xffffffff ||
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      flags & ~0x0808 ||
      flags & 0x0001 ||
      ![0, 8].includes(method) ||
      size > MAX_ENTRY ||
      compressedSize > MAX_BYTES ||
      (total += size) > MAX_BYTES
    )
      invalid('EPUB 压缩资源格式无效或超过限制。');
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    } catch {
      invalid('EPUB 文件名编码无效。');
    }
    const directory = name.endsWith('/');
    const normalized = resource(
      '',
      name.replaceAll('%', '%25').replace(/\/$/, ''),
    );
    if (
      (!directory && normalized !== name) ||
      (directory && normalized + '/' !== name) ||
      seen.has(name)
    )
      invalid('EPUB 资源名称无效。');
    seen.add(name);
    cursor = next;
    if (directory) continue;
    if (
      localOffset + 30 > directoryOffset ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    )
      invalid('EPUB ZIP 本地条目无效。');
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      dataEnd > directoryOffset ||
      localNameLength !== nameLength ||
      !buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(centralName)
    )
      invalid('EPUB ZIP 条目头不一致。');
    for (const [from, to] of ranges)
      if (localOffset < to && from < dataEnd) invalid('EPUB ZIP 条目重叠。');
    ranges.push([localOffset, dataEnd]);
    let contents;
    try {
      contents =
        method === 0
          ? buffer.subarray(dataOffset, dataEnd)
          : inflateRawSync(buffer.subarray(dataOffset, dataEnd), {
              maxOutputLength: MAX_ENTRY,
            });
    } catch {
      invalid('EPUB 压缩资源无法读取或超过限制。');
    }
    if (contents.length !== size || crc32(contents) !== crc)
      invalid('EPUB 资源校验失败。');
    Object.defineProperty(files, name, { value: contents, enumerable: true });
  }
  if (cursor !== end) invalid('EPUB ZIP 目录长度无效。');
  const read = (name) => {
    if (!Object.hasOwn(files, name)) invalid('EPUB 缺少必要资源。');
    return xml(files[name]);
  };
  const container = read('META-INF/container.xml');
  const rootfile = all(container, 'rootfile')[0]?.attrs['full-path'];
  const opfName = resource('', rootfile);
  const opf = read(opfName);
  const manifest = new Map();
  for (const item of all(all(opf, 'manifest')[0] || { children: [] }, 'item')) {
    if (!item.attrs.id || manifest.has(item.attrs.id))
      invalid('EPUB 清单标识无效。');
    manifest.set(item.attrs.id, item.attrs);
  }
  const spine = all(all(opf, 'spine')[0] || { children: [] }, 'itemref');
  if (!spine.length || spine.length > 2048) invalid('EPUB 缺少有效阅读顺序。');
  const documents = new Map();
  const chapters = spine.map((ref, index) => {
    const item = manifest.get(ref.attrs.idref);
    if (
      !item ||
      !['application/xhtml+xml', 'text/html'].includes(item['media-type'])
    )
      invalid('EPUB 章节清单无效。');
    const href = resource(opfName, item.href);
    if (!documents.has(href)) {
      const document = read(href);
      const blocks = blocksFromDocument(document);
      documents.set(href, {
        blocks,
        title: text(all(document, 'title')[0]).trim().slice(0, 512),
        text: blocks.join('\n\n'),
      });
    }
    const { title, ...document } = documents.get(href);
    return {
      ...document,
      id: `chapter-${index + 1}`,
      title: title || `第 ${index + 1} 章`,
    };
  });
  return {
    title: text(all(opf, 'title')[0]).trim().slice(0, 512) || '未命名书籍',
    author: text(all(opf, 'creator')[0]).trim().slice(0, 512) || '未知作者',
    chapters,
    hasToc: [...manifest.values()].some(
      (item) =>
        /\bnav\b/.test(item.properties || '') ||
        item['media-type'] === 'application/x-dtbncx+xml',
    ),
  };
}
module.exports = { parseEpub, MAX_BYTES, MAX_ENTRY };
