'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const iconv = require('iconv-lite');
const { parseEpub: safeParseEpub, MAX_BYTES } = require('./content.cjs');

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
  if (buffer.length > MAX_BYTES)
    fail('CONTENT_LIMIT', 'TXT 超过 32 MiB 大小限制。');
  const { text, encoding } = decodeTxt(buffer);
  const chapters = [];
  const heading =
    /^\s*(第[一二三四五六七八九十百千万零〇0-9]+[章节回部卷篇].*|Chapter\s+\d+.*)$/i;
  let current = { id: 'chapter-1', title: '正文', text: '' };
  for (const line of text.split(/\r?\n/)) {
    if (heading.test(line)) {
      if (current.text.trim() || chapters.length || current.title !== '正文')
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
  return {
    title: '',
    author: '',
    chapters: chapters
      .map((chapter) => ({
        ...chapter,
        blocks: chapter.text
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean),
      }))
      .map((chapter) => ({
        ...chapter,
        blocks: chapter.blocks.length ? chapter.blocks : [''],
      })),
    encoding,
  };
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
    if (stat.size > MAX_BYTES)
      fail('CONTENT_LIMIT', '书籍超过 32 MiB 大小限制。');
    const extension = path.extname(source).toLowerCase();
    if (!['.epub', '.txt'].includes(extension))
      fail('UNSUPPORTED_FORMAT', '仅支持 EPUB 和 TXT 文件。');
    const bytes = await fs.readFile(source);
    const parsed =
      extension === '.epub' ? safeParseEpub(bytes) : parseTxt(bytes);
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
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
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
    if (
      !/^book-[a-z0-9]{32}$/.test(book.bookId) ||
      !['epub', 'txt'].includes(book.format) ||
      book.fileName !== `${book.bookId}.${book.format}`
    )
      fail('INVALID_BOOK', '书籍文件记录无效，未执行删除。');
    const booksDirectory = path.resolve(this.root, 'books');
    const bookPath = path.resolve(
      booksDirectory,
      `${book.bookId}.${book.format}`,
    );
    if (path.dirname(bookPath) !== booksDirectory)
      fail('INVALID_BOOK', '书籍文件路径无效，未执行删除。');
    const realBooksDirectory = await fs
      .realpath(booksDirectory)
      .catch(() => '');
    const comparableBooksDirectory =
      process.platform === 'win32' && realBooksDirectory.startsWith('\\\\?\\')
        ? realBooksDirectory.slice(4)
        : realBooksDirectory;
    if (
      realBooksDirectory &&
      (process.platform === 'win32'
        ? comparableBooksDirectory.toLowerCase() !==
          booksDirectory.toLowerCase()
        : realBooksDirectory !== booksDirectory)
    )
      fail('INVALID_BOOK', '书籍目录路径无效，未执行删除。');
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
    if (!keepNotes) await this.store.remove(`reading-${book.bookId}`);
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
  parseEpub: safeParseEpub,
  parseTxt,
  decodeTxt,
};
