'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  artifacts,
  check,
  crc32,
  generate,
} = require('../../tools/fixtures.cjs');

function unzipStored(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString();
    const start = offset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), bytes.readUInt32LE(offset + 14));
    entries.set(name, data);
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt32LE(end + 16), offset);
  assert.equal(bytes.readUInt16LE(end + 10), entries.size);
  let central = offset;
  for (const [name, data] of entries) {
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    const local = bytes.readUInt32LE(central + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(central + 16), crc32(data));
    const length = bytes.readUInt16LE(central + 28);
    assert.equal(
      bytes.subarray(central + 46, central + 46 + length).toString(),
      name,
    );
    central += 46 + length;
  }
  assert.equal(central, end);
  return entries;
}

test('S00/T-003: committed fixture bytes match recipe and checksums', () => {
  assert.equal(check(), 10);
});

test('S00/T-003: generation repeats byte-for-byte and detects corruption', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-fixtures-'));
  try {
    generate(directory);
    assert.equal(check(directory), 10);
    const first = fs.readFileSync(path.join(directory, 'manifest.json'));
    generate(directory);
    assert.deepEqual(
      fs.readFileSync(path.join(directory, 'manifest.json')),
      first,
    );
    fs.appendFileSync(path.join(directory, 'chinese.epub'), 'corruption');
    assert.throws(() => check(directory), /chinese.epub/);
    generate(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.files[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => check(directory), /manifest differs/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('S01-A2: GBK, BOM, malformed encoding, no headings and million characters', () => {
  const files = new Map(artifacts().map(({ name, bytes }) => [name, bytes]));
  assert.equal(
    new TextDecoder('gbk', { fatal: true }).decode(
      files.get('chinese-gbk.txt'),
    ),
    '中文测试\n第一章\n',
  );
  assert.deepEqual(
    [...files.get('chinese-bom.txt').subarray(0, 3)],
    [239, 187, 191],
  );
  assert.throws(() =>
    new TextDecoder('utf-8', { fatal: true }).decode(
      files.get('malformed-utf8.txt'),
    ),
  );
  assert.doesNotMatch(files.get('no-toc.txt').toString(), /第.+章/);
  const long = files.get('million-chars.txt').toString('utf8');
  assert.equal([...long].length, 1000000);
  assert.equal(files.get('million-chars.txt').length, 3000000);
  assert.equal(
    files.get('chinese-utf8.txt').toString().split('窗外有风。').length - 1,
    2,
  );
});

test('S01-A1/S03-A2: EPUB ZIP integrity, NCX and typography variants', () => {
  const files = new Map(artifacts().map(({ name, bytes }) => [name, bytes]));
  const book = unzipStored(files.get('chinese.epub'));
  assert.equal([...book.keys()][0], 'mimetype');
  assert.equal(book.get('mimetype').toString(), 'application/epub+zip');
  assert.match(
    book.get('META-INF/container.xml').toString(),
    /OEBPS\/book.opf/,
  );
  assert.match(book.get('OEBPS/book.opf').toString(), /<spine toc="ncx">/);
  assert.match(book.get('OEBPS/toc.ncx').toString(), /chapter.xhtml/);
  const reflow = unzipStored(files.get('reflow.epub'));
  const plainText = (buffer) =>
    buffer
      .toString()
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '');
  assert.equal(
    plainText(book.get('OEBPS/chapter.xhtml')),
    plainText(reflow.get('OEBPS/chapter.xhtml')),
  );
  assert.equal(
    unzipStored(files.get('missing-toc.epub')).has('OEBPS/toc.ncx'),
    false,
  );
  assert.throws(() => unzipStored(files.get('malformed.epub')));
});
