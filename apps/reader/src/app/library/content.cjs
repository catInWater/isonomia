'use strict';
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { SaxesParser } = require('saxes');
const { imageRules, imageLayout } = require('./image-layout.cjs');
const MAX_BOOK_LINKS = 8192;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
// Deflate options, the enhanced-deflate compatibility bit, data descriptors and UTF-8 names.
// Encryption and every other general-purpose flag remain rejected.
const ZIP_SUPPORTED_FLAGS = 0x081e;
const IMAGE_MEDIA_TYPES = new Map([
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
]);
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
const IMAGE_MARKER = '￼';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BOOK_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BOOK_IMAGE_REFERENCES = 4096;
const MAX_CHAPTER_IMAGE_BYTES = 2 * 1024 * 1024;

const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 40_000_000;
function validImageDimensions(width, height) {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}
function imageDimensions(bytes, type) {
  if (
    type === 'image/png' &&
    bytes.length >= 24 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (
    type === 'image/gif' &&
    bytes.length >= 10 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  )
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (
    type === 'image/jpeg' &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  )
    return jpegDimensions(bytes);
  if (
    type === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X')
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (chunk === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a')
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === 'VP8L' && bytes[20] === 0x2f)
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height:
          1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
  }
  return null;
}
function detectedImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  )
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function imageDataUrl(bytes, expectedMediaType) {
  const type = detectedImageType(bytes);
  const dimensions = type && imageDimensions(bytes, type);
  if (
    !type ||
    type !== expectedMediaType ||
    bytes.length > MAX_IMAGE_BYTES ||
    !dimensions ||
    !validImageDimensions(dimensions.width, dimensions.height)
  )
    return null;
  return `data:${type};base64,${bytes.toString('base64')}`;
}

function blocksFromDocument(
  document,
  documentPath,
  resolveImage,
  reserveImage,
  rules,
) {
  const blocks = [];
  const images = [];
  const links = [];
  const anchors = new Map();
  let anchorCount = 0;
  let imageBytes = 0;
  let current = '';
  let currentImages = [];
  let currentLinks = [];
  let currentAnchors = [];
  let activeHref = null;
  const append = (value) => {
    const offset = current.length;
    current += value;
    if (activeHref && value.length && currentLinks.length < MAX_BOOK_LINKS) {
      const last = currentLinks.at(-1);
      if (last?.href === activeHref && last.end === offset)
        last.end = current.length;
      else currentLinks.push({ href: activeHref, offset, end: current.length });
    }
  };
  const flush = () => {
    const value = current.replace(/\s+/g, ' ').trim();
    const normalizedOffset = (offset) =>
      Math.min(
        value.length,
        current.slice(0, offset).replace(/\s+/g, ' ').trimStart().length,
      );
    if (value) {
      const blockIndex = blocks.length;
      blocks.push(value);
      for (const image of currentImages)
        images.push({
          ...image,
          blockIndex,
          offset: normalizedOffset(image.offset),
        });
      for (const link of currentLinks) {
        const offset = normalizedOffset(link.offset);
        const end = normalizedOffset(link.end);
        if (end > offset && links.length < MAX_BOOK_LINKS)
          links.push({
            blockIndex,
            offset,
            length: end - offset,
            href: link.href,
          });
      }
      for (const anchor of currentAnchors) {
        if (!anchors.has(anchor.id))
          anchors.set(anchor.id, {
            blockIndex,
            offset: normalizedOffset(anchor.offset),
          });
      }
      currentAnchors = [];
    } else
      currentAnchors = currentAnchors.map((anchor) => ({
        ...anchor,
        offset: 0,
      }));
    current = '';
    currentImages = [];
    currentLinks = [];
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
      append(node);
      return;
    }
    if (omitted.has(node.name)) return;
    if (boundary.test(node.name)) flush();
    for (const id of [
      node.attrs.id,
      node.attrs['xml:id'],
      node.name === 'a' ? node.attrs.name : null,
    ]) {
      if (
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= 512 &&
        anchorCount < MAX_BOOK_LINKS
      ) {
        currentAnchors.push({ id, offset: current.length });
        anchorCount++;
      }
    }
    const previousHref = activeHref;
    if (node.name === 'a' && typeof node.attrs.href === 'string')
      activeHref = node.attrs.href.length <= 4096 ? node.attrs.href : null;
    if (node.name === 'img') {
      const alt =
        typeof node.attrs.alt === 'string' ? node.attrs.alt.slice(0, 512) : '';
      let image = null;
      try {
        image = resolveImage(documentPath, node.attrs.src);
      } catch {
        // A broken optional image must not make otherwise readable text fail.
      }
      if (
        image &&
        image.size <= MAX_CHAPTER_IMAGE_BYTES &&
        imageBytes + image.size <= MAX_CHAPTER_IMAGE_BYTES &&
        reserveImage(image.size)
      ) {
        imageBytes += image.size;
        currentImages.push({
          assetId: image.assetId,
          size: image.size,
          alt,
          ...imageLayout(node.attrs, rules, image),
          offset: current.length,
        });
        append(IMAGE_MARKER);
      } else append(alt ? `[${alt}]` : '[图片]');
    } else node.children.forEach(walk);
    activeHref = previousHref;
    if (boundary.test(node.name)) flush();
  }
  const body = all(document, 'body')[0];
  if (!body) invalid('EPUB 缺少章节正文。');
  walk(body);
  flush();
  // Empty/end-of-document anchors still have a valid destination.
  for (const anchor of currentAnchors) {
    if (!anchors.has(anchor.id))
      anchors.set(anchor.id, {
        blockIndex: Math.max(0, blocks.length - 1),
        offset: blocks.at(-1)?.length || 0,
      });
  }
  return { blocks: blocks.length ? blocks : [''], images, links, anchors };
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
      flags & ~ZIP_SUPPORTED_FLAGS ||
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
  const manifestByPath = new Map();
  for (const item of all(all(opf, 'manifest')[0] || { children: [] }, 'item')) {
    if (!item.attrs.id || manifest.has(item.attrs.id))
      invalid('EPUB 清单标识无效。');
    manifest.set(item.attrs.id, item.attrs);
    if (item.attrs.href) {
      try {
        manifestByPath.set(resource(opfName, item.attrs.href), item.attrs);
      } catch {
        // Unreferenced optional resources are ignored; a spine resource is checked below.
      }
    }
  }
  const assets = Object.create(null);
  const assetByPath = new Map();
  let totalImageBytes = 0;
  let totalImageReferenceBytes = 0;
  let totalImageReferences = 0;
  const reserveImageReference = (size) => {
    if (
      totalImageReferences >= MAX_BOOK_IMAGE_REFERENCES ||
      totalImageReferenceBytes + size > MAX_BOOK_IMAGE_BYTES
    )
      return false;
    totalImageReferences++;
    totalImageReferenceBytes += size;
    return true;
  };
  const getImageAsset = (name, mediaType) => {
    if (assetByPath.has(name)) return assetByPath.get(name);
    const declaredType = IMAGE_MEDIA_TYPES.get(
      typeof mediaType === 'string' ? mediaType.toLowerCase() : '',
    );
    const contents = files[name];
    if (
      !declaredType ||
      !contents ||
      contents.length > MAX_IMAGE_BYTES ||
      totalImageBytes + contents.length > MAX_BOOK_IMAGE_BYTES
    ) {
      assetByPath.set(name, null);
      return null;
    }
    const actualType = detectedImageType(contents);
    if (actualType !== declaredType) {
      assetByPath.set(name, null);
      return null;
    }
    const dataUrl = imageDataUrl(contents, actualType);
    if (!dataUrl) {
      assetByPath.set(name, null);
      return null;
    }
    const assetId = `image-${Object.keys(assets).length + 1}`;
    assets[assetId] = {
      mediaType: actualType,
      bytes: contents,
      dataUrl,
      ...imageDimensions(contents, actualType),
    };
    totalImageBytes += contents.length;
    assetByPath.set(name, assetId);
    return assetId;
  };
  const resolveImage = (documentPath, href) => {
    if (typeof href !== 'string') return null;
    let name;
    try {
      name = resource(documentPath, href);
    } catch {
      return null;
    }
    const item = manifestByPath.get(name);
    const assetId = item ? getImageAsset(name, item['media-type']) : null;
    return assetId
      ? {
          assetId,
          width: assets[assetId].width,
          height: assets[assetId].height,
          size: assets[assetId].bytes.length,
        }
      : null;
  };
  const stylesheetCache = new Map();
  let stylesheetBytes = 0;
  const layoutRules = (document, documentPath) => {
    const rules = [];
    for (const link of all(document, 'link').slice(0, 32)) {
      if (
        !String(link.attrs.rel || '')
          .toLowerCase()
          .split(/\s+/)
          .includes('stylesheet')
      )
        continue;
      try {
        const name = resource(documentPath, link.attrs.href);
        if (manifestByPath.get(name)?.['media-type'] !== 'text/css') continue;
        if (!stylesheetCache.has(name)) {
          const bytes = files[name];
          if (
            !bytes ||
            bytes.length > 65536 ||
            stylesheetBytes + bytes.length > 262144
          )
            continue;
          stylesheetBytes += bytes.length;
          stylesheetCache.set(name, imageRules(bytes.toString('utf8')));
        }
        rules.push(...stylesheetCache.get(name));
      } catch {
        /* Optional styling never authorizes a resource request. */
      }
      if (rules.length >= 512) break;
    }
    for (const style of all(document, 'style').slice(0, 16)) {
      if (rules.length >= 512) break;
      rules.push(...imageRules(text(style)));
    }
    return rules.slice(0, 512);
  };
  const coverMetadataId = all(opf, 'meta').find(
    (item) => item.attrs.name?.toLowerCase() === 'cover',
  )?.attrs.content;
  const coverItem =
    manifest.get(coverMetadataId) ||
    [...manifest.values()].find((item) =>
      (item.properties || '').split(/\s+/).includes('cover-image'),
    );
  let coverAssetId = null;
  if (coverItem?.href) {
    try {
      coverAssetId = getImageAsset(
        resource(opfName, coverItem.href),
        coverItem['media-type'],
      );
    } catch {
      // A bad or unsupported optional cover falls back to the generated cover.
    }
  }
  const spine = all(all(opf, 'spine')[0] || { children: [] }, 'itemref');
  if (!spine.length || spine.length > 2048) invalid('EPUB 缺少有效阅读顺序。');
  const documents = new Map();
  let returnedImageBytes = 0;
  let returnedImageReferences = 0;
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
      const content = blocksFromDocument(
        document,
        href,
        resolveImage,
        reserveImageReference,
        layoutRules(document, href),
      );
      documents.set(href, {
        ...content,
        title: text(all(document, 'title')[0]).trim().slice(0, 512),
      });
    }
    const document = documents.get(href);
    const imagesByBlock = new Map();
    for (const image of document.images) {
      const images = imagesByBlock.get(image.blockIndex) || [];
      images.push(image);
      imagesByBlock.set(image.blockIndex, images);
    }
    const chapterImages = [];
    const replacements = [];
    const remap = (blockIndex, offset) =>
      offset +
      replacements
        .filter(
          (item) => item.blockIndex === blockIndex && item.offset < offset,
        )
        .reduce((sum, item) => sum + item.delta, 0);
    const blocks = document.blocks.map((block, blockIndex) => {
      let cursor = 0;
      let rendered = '';
      for (const image of imagesByBlock.get(blockIndex) || []) {
        if (
          image.offset < cursor ||
          image.offset >= block.length ||
          block[image.offset] !== IMAGE_MARKER
        )
          continue;
        rendered += block.slice(cursor, image.offset);
        if (
          returnedImageReferences < MAX_BOOK_IMAGE_REFERENCES &&
          returnedImageBytes + image.size <= MAX_BOOK_IMAGE_BYTES
        ) {
          const offset = rendered.length;
          rendered += IMAGE_MARKER;
          const { assetId, ...reference } = image;
          chapterImages.push({
            ...reference,
            offset,
            src: assets[assetId].dataUrl,
          });
          returnedImageBytes += image.size;
          returnedImageReferences++;
        } else {
          const fallback = (image.alt ? `[${image.alt}]` : '[图片]').replace(
            /\s+/g,
            ' ',
          );
          rendered += fallback;
          replacements.push({
            blockIndex,
            offset: image.offset,
            delta: fallback.length - 1,
          });
        }
        cursor = image.offset + 1;
      }
      return rendered + block.slice(cursor);
    });
    return {
      id: `chapter-${index + 1}`,
      title: document.title || `第 ${index + 1} 章`,
      blocks,
      images: chapterImages,
      text: blocks.join('\n\n'),
      resourcePath: href,
      anchors: new Map(
        [...document.anchors].map(([id, location]) => [
          id,
          { ...location, offset: remap(location.blockIndex, location.offset) },
        ]),
      ),
      sourceLinks: document.links.map((link) => ({
        ...link,
        offset: remap(link.blockIndex, link.offset),
        length:
          remap(link.blockIndex, link.offset + link.length) -
          remap(link.blockIndex, link.offset),
      })),
    };
  });
  const chaptersByPath = new Map();
  for (const chapter of chapters) {
    if (!chaptersByPath.has(chapter.resourcePath))
      chaptersByPath.set(chapter.resourcePath, chapter);
  }
  let returnedLinks = 0;
  const publicChapters = chapters.map((chapter) => {
    const links = [];
    for (const link of chapter.sourceLinks) {
      if (returnedLinks >= MAX_BOOK_LINKS) break;
      try {
        if (/[\\\u0000- ]/.test(link.href)) continue;
        const hash = link.href.indexOf('#');
        const pathPart = hash < 0 ? link.href : link.href.slice(0, hash);
        const fragment =
          hash < 0 ? '' : decodeURIComponent(link.href.slice(hash + 1));
        if (fragment.length > 512 || /[\u0000-\u001f]/.test(fragment)) continue;
        const targetPath = pathPart
          ? resource(chapter.resourcePath, pathPart)
          : chapter.resourcePath;
        const targetChapter =
          targetPath === chapter.resourcePath
            ? chapter
            : chaptersByPath.get(targetPath);
        const location = fragment
          ? targetChapter?.anchors.get(fragment)
          : { blockIndex: 0, offset: 0 };
        if (!targetChapter || !location) continue;
        links.push({
          blockIndex: link.blockIndex,
          offset: link.offset,
          length: link.length,
          target: { chapterId: targetChapter.id, ...location },
        });
        returnedLinks++;
      } catch {
        /* External, malformed and missing targets stay inert text. */
      }
    }
    const {
      resourcePath: _path,
      anchors: _anchors,
      sourceLinks: _links,
      ...content
    } = chapter;
    return { ...content, links };
  });
  return {
    title: text(all(opf, 'title')[0]).trim().slice(0, 512) || '未命名书籍',
    author: text(all(opf, 'creator')[0]).trim().slice(0, 512) || '未知作者',
    chapters: publicChapters,
    cover: coverAssetId ? assets[coverAssetId] : null,
    hasToc: [...manifest.values()].some(
      (item) =>
        /\bnav\b/.test(item.properties || '') ||
        item['media-type'] === 'application/x-dtbncx+xml',
    ),
  };
}
module.exports = {
  parseEpub,
  imageDataUrl,
  MAX_BYTES,
  MAX_ENTRY,
  MAX_IMAGE_BYTES,
};
