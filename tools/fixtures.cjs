'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { deflateRawSync, deflateSync } = require('node:zlib');
const root = path.resolve(__dirname, '../tests/fixtures');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Deterministic ZIP: fixed DOS epoch, no platform metadata, mimetype first.
function zip(entries, { flags = 0x800, method = 0 } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const uncompressed = Buffer.from(value);
    const entryMethod = typeof method === 'function' ? method(name) : method;
    const data =
      entryMethod === 8 ? deflateRawSync(uncompressed) : uncompressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entryMethod, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(uncompressed), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    local.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    parts.push(local, filename, data);
    offset += local.length + filename.length + data.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, index, end]);
}

function epub({
  missingToc = false,
  reflow = false,
  images = false,
  flags = 0x800,
  method = 0,
  body: customBody,
} = {}) {
  const body =
    customBody ??
    (images
      ? '<h1>第一章 合成书</h1><p>窗外有风。<img src="images/pixel.png" alt="红色像素"/>孤独不是答案。</p><p>第二处：窗外有风。</p>'
      : '<h1>第一章 合成书</h1><p>窗外有风。孤独不是答案。</p><p>第二处：窗外有风。</p>');
  const pngChunk = (type, data) => {
    const name = Buffer.from(type);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    name.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
    return chunk;
  };
  const pngHeader = Buffer.alloc(13);
  pngHeader.writeUInt32BE(1, 0);
  pngHeader.writeUInt32BE(1, 4);
  pngHeader[8] = 8;
  pngHeader[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', pngHeader),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return zip(
    [
      ['mimetype', 'application/epub+zip'],
      ...(images ? [['OEBPS/images/pixel.png', png]] : []),
      [
        'META-INF/container.xml',
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ],
      [
        'OEBPS/book.opf',
        `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:isonomia:synthetic:v1</dc:identifier><dc:title>合成测试书</dc:title><dc:language>zh-CN</dc:language><dc:creator>Reader fixture contributors</dc:creator>${images ? '<meta name="cover" content="cover"/>' : ''}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${images ? '<item id="pixel" href="images/pixel.png" media-type="image/png"/><item id="cover" href="images/pixel.png" media-type="image/png"/>' : ''}${missingToc ? '' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}</manifest><spine${missingToc ? '' : ' toc="ncx"'}><itemref idref="chapter"/></spine></package>`,
      ],
      [
        'OEBPS/chapter.xhtml',
        `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>第一章</title>${reflow ? '<style>body { font-size: 150%; line-height: 2; margin: 3em; }</style>' : ''}</head><body>${body}</body></html>`,
      ],
      ...(missingToc
        ? []
        : [
            [
              'OEBPS/toc.ncx',
              '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:isonomia:synthetic:v1"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>合成测试书</text></docTitle><navMap><navPoint id="chapter" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>',
            ],
          ]),
    ],
    { flags, method },
  );
}

function artifacts() {
  const text =
    '第一章 合成书\n窗外有风。孤独不是答案。\n第二章 再读\n窗外有风。\n';
  return [
    [
      'chinese-utf8.txt',
      Buffer.from(text),
      'UTF-8 Chinese, chapters, repeated anchor quote',
    ],
    ['chinese-bom.txt', Buffer.from('﻿' + text), 'UTF-8 BOM'],
    [
      'chinese-gbk.txt',
      Buffer.from('d6d0cec4b2e2cad40ab5dad2bbd5c20a', 'hex'),
      'GBK: 中文测试\n第一章\n',
    ],
    [
      'no-toc.txt',
      Buffer.from('这是一段没有章节标题的合成正文。\n'),
      'TXT without chapter headings',
    ],
    [
      'malformed-utf8.txt',
      Buffer.from([0xe4, 0xb8, 0xff, 0x00]),
      'Invalid UTF-8 and NUL; reject or request encoding',
    ],
    [
      'million-chars.txt',
      Buffer.from('天地玄黄宇宙洪荒日月'.repeat(100000)),
      'Exactly 1,000,000 Unicode characters; not a performance result',
    ],
    [
      'chinese.epub',
      epub(),
      'Minimal EPUB 2 Chinese with NCX and repeated quote',
    ],
    [
      'epub-images.epub',
      epub({
        images: true,
        flags: 0x0816,
        method: (name) => (name === 'mimetype' ? 0 : 8),
      }),
      'EPUB with common ZIP flags, inline PNG, and EPUB 2 cover metadata',
    ],
    [
      'reflow.epub',
      epub({ reflow: true }),
      'Same text and spine with changed typography',
    ],
    [
      'missing-toc.epub',
      epub({ missingToc: true }),
      'Intentionally nonconforming missing NCX; graceful fallback',
    ],
    [
      'malformed.epub',
      Buffer.from('504b030414000000', 'hex'),
      'Truncated ZIP; import failure',
    ],
  ].map(([name, bytes, purpose]) => ({ name, bytes, purpose }));
}

function manifest(files) {
  return {
    schemaVersion: 1,
    license: 'CC0-1.0',
    source:
      'Original synthetic text and container bytes generated by tools/fixtures.cjs; no external books or personal data.',
    files: files.map(({ name, bytes, purpose }) => ({
      name,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      purpose,
    })),
  };
}

function generate(directory = root) {
  const files = artifacts();
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files)
    fs.writeFileSync(path.join(directory, file.name), file.bytes);
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify(manifest(files), null, 2) + '\n',
  );
}

function check(directory = root) {
  const files = artifacts();
  const expected = manifest(files);
  const actual = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Fixture manifest differs from deterministic recipe');
  for (const file of files) {
    if (!fs.readFileSync(path.join(directory, file.name)).equals(file.bytes))
      throw new Error(`Fixture bytes differ: ${file.name}`);
  }
  return files.length;
}

if (require.main === module) {
  if (process.argv[2] === '--write') generate();
  else if (process.argv.length === 2 || process.argv[2] === '--check')
    console.log(`Verified ${check()} fixtures`);
  else throw new Error('Usage: node tools/fixtures.cjs [--write|--check]');
}
module.exports = { artifacts, check, crc32, epub, generate, manifest, zip };
