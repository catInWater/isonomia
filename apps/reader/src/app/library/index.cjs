'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const iconv = require('iconv-lite');
const { unzipSync, strFromU8 } = require('fflate');

class LibraryError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'LibraryError';
    this.code = code;
  }
}
function fail(code, message, cause) {
  throw new LibraryError(code, message, cause);
}
function cleanText(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function xmlValue(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  return match ? cleanText(match[1]) : '';
}
function resolveZipName(base, name) {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(base), name),
  );
  if (resolved.startsWith('../') || resolved === '..')
    fail('INVALID_EPUB', 'EPUB 包含越界资源路径。');
  return resolved;
}
function readZipEntry(files, name) {
  if (!files[name]) fail('INVALID_EPUB', `EPUB 缺少必要文件：${name}。`);
  return strFromU8(files[name]);
}
function parseEpub(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    fail('INVALID_EPUB', 'EPUB 文件损坏或不是有效的 ZIP 容器。', error);
  }
  const container = readZipEntry(files, 'META-INF/container.xml');
  const rootfile = container.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootfile) fail('INVALID_EPUB', 'EPUB 缺少 OPF 书籍清单。');
  const opf = readZipEntry(files, rootfile);
  const title =
    xmlValue(opf, 'dc:title') || xmlValue(opf, 'title') || '未命名书籍';
  const author =
    xmlValue(opf, 'dc:creator') || xmlValue(opf, 'creator') || '未知作者';
  const manifest = new Map();
  for (const item of opf.matchAll(/<item\b([^>]+)>/gi)) {
    const attrs = item[1];
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)/i)?.[1];
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)/i)?.[1];
    if (id && href) manifest.set(id, { name: resolveZipName(rootfile, href) });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)/gi)]
    .map((match) => manifest.get(match[1]))
    .filter(Boolean);
  const chapters = spine.map((item, index) => {
    const html = readZipEntry(files, item.name);
    return {
      id: `chapter-${index + 1}`,
      title: xmlValue(html, 'title') || `第 ${index + 1} 章`,
      text: cleanText(html),
    };
  });
  return { title, author, chapters, hasToc: /<nav\b|toc\.ncx/i.test(opf) };
}
function decodeTxt(buffer) {
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  )
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8 BOM' };
  if (
    buffer.length >= 2 &&
    buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
  )
    return {
      text: buffer.subarray(2).toString('utf16le'),
      encoding: 'UTF-16LE',
    };
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return { text: utf8, encoding: 'UTF-8' };
  const gbk = iconv.decode(buffer, 'gbk');
  if (!gbk.includes('�')) return { text: gbk, encoding: 'GBK' };
  fail('UNKNOWN_ENCODING', '无法确定文本编码，请转换为 UTF-8 后重试。');
}
function parseTxt(buffer) {
  const { text, encoding } = decodeTxt(buffer);
  const chapters = [];
  const heading =
    /^\s*(第[一二三四五六七八九十百千万零〇0-9]+[章节回部卷篇].*|Chapter\s+\d+.*)$/i;
  let current = { id: 'chapter-1', title: '正文', text: '' };
  for (const line of text.split(/\r?\n/)) {
    if (heading.test(line) && current.text.trim()) {
      chapters.push({ ...current, text: current.text.trim() });
      current = {
        id: `chapter-${chapters.length + 1}`,
        title: line.trim(),
        text: '',
      };
    } else current.text += `${line}\n`;
  }
  if (current.text.trim() || !chapters.length)
    chapters.push({ ...current, text: current.text.trim() });
  return { title: '', author: '', chapters, encoding };
}
class LibraryManager {
  constructor({ root, store }) {
    if (!path.isAbsolute(root))
      fail('INVALID_ROOT', '书籍数据目录必须是绝对路径。');
    this.root = path.resolve(root);
    this.store = store;
  }
  async _catalog() {
    const record = await this.store.load('library');
    return record || { revision: 0, data: { books: [] } };
  }
  async list() {
    return (await this._catalog()).data.books.filter(
      (book) => book.fileStatus === 'available',
    );
  }
  async importFile(sourcePath, keepDuplicate = false) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
      fail('INVALID_PATH', '导入路径无效。');
    const source = path.resolve(sourcePath);
    const stat = await fs
      .stat(source)
      .catch((error) => fail('IMPORT_FAILED', '找不到要导入的文件。', error));
    if (!stat.isFile()) fail('IMPORT_FAILED', '导入目标不是文件。');
    const extension = path.extname(source).toLowerCase();
    if (!['.epub', '.txt'].includes(extension))
      fail('UNSUPPORTED_FORMAT', '仅支持 EPUB 和 TXT 文件。');
    const bytes = await fs.readFile(source);
    const parsed = extension === '.epub' ? parseEpub(bytes) : parseTxt(bytes);
    const catalog = await this._catalog();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const duplicate = catalog.data.books.find(
      (book) => book.contentHash === hash && book.fileStatus !== 'removed',
    );
    if (duplicate && !keepDuplicate)
      fail('DUPLICATE', `这本书已存在：${duplicate.title}。`);
    const bookId = `book-${randomUUID().replaceAll('-', '')}`;
    const destination = path.join(this.root, 'books', `${bookId}${extension}`);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
    const book = {
      bookId,
      title: parsed.title || path.basename(source, extension),
      author: parsed.author || '未知作者',
      format: extension.slice(1),
      contentHash: hash,
      fileName: path.basename(destination),
      fileStatus: 'available',
      importedAt: new Date().toISOString(),
      lastReadAt: null,
      chapters: parsed.chapters.map(({ id, title }) => ({ id, title })),
      encoding: parsed.encoding || null,
    };
    try {
      await this.store.save(
        'library',
        { books: [...catalog.data.books, book] },
        catalog.revision,
      );
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
    return book;
  }
  async remove(bookId, keepNotes) {
    const catalog = await this._catalog();
    const index = catalog.data.books.findIndex(
      (book) => book.bookId === bookId,
    );
    if (index < 0) fail('NOT_FOUND', '找不到这本书。');
    const book = catalog.data.books[index];
    const books = keepNotes
      ? [...catalog.data.books]
      : catalog.data.books.filter((item) => item.bookId !== bookId);
    if (keepNotes)
      books[index] = {
        ...book,
        fileStatus: 'removed',
        removedAt: new Date().toISOString(),
      };
    await this.store.save('library', { books }, catalog.revision);
    if (book.fileName)
      await fs.rm(path.join(this.root, 'books', book.fileName), {
        force: true,
      });
    return keepNotes ? books[index] : book;
  }
}
module.exports = {
  LibraryManager,
  LibraryError,
  parseEpub,
  parseTxt,
  decodeTxt,
};
