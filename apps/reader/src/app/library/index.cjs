'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const iconv = require('iconv-lite');
const {
  parseEpub: safeParseEpub,
  imageDataUrl,
  MAX_BYTES,
  MAX_IMAGE_BYTES,
} = require('./content.cjs');

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
function comparablePath(value) {
  if (process.platform !== 'win32') return value;
  const normalized = value.startsWith('\\\\?\\') ? value.slice(4) : value;
  return normalized.toLowerCase();
}
function validStoredBookName({ bookId, format, fileName }) {
  return (
    typeof bookId === 'string' &&
    /^book-[a-z0-9]{32}$/.test(bookId) &&
    ['epub', 'txt'].includes(format) &&
    typeof fileName === 'string' &&
    new RegExp(`^${bookId}(?:-[a-f0-9]{32})?\\.${format}$`).test(fileName)
  );
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
  async list(includeRemoved = false) {
    return (await this._catalog()).data.books.filter(
      (book) => includeRemoved || book.fileStatus === 'available',
    );
  }
  async findBook(bookId) {
    return (await this._catalog()).data.books.find(
      (book) => book.bookId === bookId,
    );
  }
  async _booksDirectory(create = false) {
    const directory = path.join(this.root, 'books');
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const realRoot = await fs.realpath(this.root).catch(() => '');
    const realDirectory = await fs.realpath(directory).catch(() => '');
    const stat = await fs.lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat && !create) return null;
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      !realRoot ||
      !realDirectory ||
      comparablePath(path.dirname(realDirectory)) !== comparablePath(realRoot)
    )
      fail('UNSAFE_PATH', '书籍目录路径无效，未执行文件操作。');
    return directory;
  }
  async _coverDirectory(create = false) {
    const directory = path.resolve(this.root, 'covers');
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
    const realRoot = await fs.realpath(this.root).catch(() => '');
    const realDirectory = await fs.realpath(directory).catch(() => '');
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !realRoot ||
      !realDirectory ||
      comparablePath(path.dirname(realDirectory)) !== comparablePath(realRoot)
    )
      fail('UNSAFE_PATH', '封面目录路径无效，未执行文件操作。');
    return directory;
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
    const destination = path.join(
      await this._booksDirectory(true),
      `${bookId}${extension}`,
    );
    let coverPath = null;
    try {
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      if (parsed.cover) {
        const coverDirectory = await this._coverDirectory(true);
        coverPath = path.join(coverDirectory, `${bookId}.img`);
        await fs.writeFile(coverPath, parsed.cover.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      }
    } catch (error) {
      await fs.rm(destination, { force: true });
      if (coverPath) await fs.rm(coverPath, { force: true });
      throw error;
    }
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
      coverMimeType: parsed.cover?.mediaType || null,
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
      if (coverPath) await fs.rm(coverPath, { force: true });
      throw error;
    }
    return book;
  }
  async replaceFile(bookId, sourcePath) {
    const catalog = await this._catalog();
    const book = catalog.data.books.find((item) => item.bookId === bookId);
    if (!book || !validStoredBookName(book))
      fail('NOT_FOUND', '找不到这本书。');
    if (
      !path.isAbsolute(sourcePath) ||
      path.extname(sourcePath).toLowerCase() !== `.${book.format}`
    )
      fail('UNSUPPORTED_FORMAT', '请选择与原书格式相同的文件。');
    const source = await fs.open(sourcePath, 'r');
    let bytes;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        fail('CONTENT_LIMIT', '请选择不超过 32 MiB 的书籍。');
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await source.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== stat.size)
        fail('CONTENT_CHANGED', '选择的文件正在变化，请稍后重试。');
      bytes = buffer.subarray(0, size);
    } finally {
      await source.close();
    }
    const parsed =
      book.format === 'epub' ? safeParseEpub(bytes) : parseTxt(bytes);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const fileName = `${bookId}-${randomUUID().replaceAll('-', '')}.${book.format}`;
    const directory = await this._booksDirectory(true);
    const destination = path.join(directory, fileName);
    const handle = await fs.open(destination, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== 'win32') {
        const dir = await fs.open(directory, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } catch (error) {
      await fs.rm(destination, { force: true }).catch(() => {});
      throw error;
    }
    const next = {
      ...book,
      fileStatus: 'available',
      fileName,
      contentHash,
      chapters: parsed.chapters.map(({ id, title }) => ({ id, title })),
      encoding: parsed.encoding || null,
    };
    // An unacknowledged save may already have published the new catalog. Keep
    // the checked copy in that case, and retain older copies for catalog recovery.
    await this.store.save(
      'library',
      {
        books: catalog.data.books.map((item) =>
          item.bookId === bookId ? next : item,
        ),
      },
      catalog.revision,
    );
    return next;
  }
  async _readStoredBook(book) {
    if (!validStoredBookName(book)) return null;
    const directory = await this._booksDirectory();
    if (!directory) return null;
    const file = path.resolve(directory, book.fileName);
    if (path.dirname(file) !== directory) return null;
    const realRoot = await fs.realpath(this.root).catch(() => '');
    const realDirectory = await fs.realpath(directory).catch(() => '');
    const realFile = await fs.realpath(file).catch(() => '');
    if (
      !realRoot ||
      !realDirectory ||
      !realFile ||
      comparablePath(path.dirname(realDirectory)) !==
        comparablePath(realRoot) ||
      comparablePath(path.dirname(realFile)) !== comparablePath(realDirectory)
    )
      return null;
    const handle = await fs
      .open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      .catch(() => null);
    if (!handle) return null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(
          bytes,
          size,
          bytes.length - size,
          size,
        );
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size !== stat.size) return null;
      const content = bytes.subarray(0, size);
      return createHash('sha256').update(content).digest('hex') ===
        book.contentHash
        ? content
        : null;
    } finally {
      await handle.close();
    }
  }
  async cover(bookId) {
    if (!/^book-[a-z0-9]{32}$/.test(bookId)) return null;
    const record = await this._catalog();
    const book = record.data.books.find(
      (item) => item.bookId === bookId && item.fileStatus === 'available',
    );
    if (!book) return null;
    let source = null;
    if (book.coverMimeType) {
      const directory = await this._coverDirectory();
      if (directory) {
        const file = path.resolve(directory, `${bookId}.img`);
        const realDirectory = await fs.realpath(directory);
        const realFile = await fs.realpath(file).catch(() => '');
        if (
          path.dirname(file) === directory &&
          realFile &&
          comparablePath(path.dirname(realFile)) ===
            comparablePath(realDirectory)
        ) {
          const handle = await fs
            .open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
            .catch(() => null);
          if (handle) {
            try {
              const stat = await handle.stat();
              if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
                const bytes = Buffer.alloc(stat.size + 1);
                let size = 0;
                while (size < bytes.length) {
                  const result = await handle.read(
                    bytes,
                    size,
                    bytes.length - size,
                    size,
                  );
                  if (!result.bytesRead) break;
                  size += result.bytesRead;
                }
                if (size === stat.size)
                  source = imageDataUrl(
                    bytes.subarray(0, size),
                    book.coverMimeType,
                  );
              }
            } finally {
              await handle.close();
            }
          }
        }
      }
    }
    if (!source && book.format === 'epub') {
      const bytes = await this._readStoredBook(book);
      if (bytes) {
        const parsed = safeParseEpub(bytes);
        if (parsed.cover) {
          source = imageDataUrl(parsed.cover.bytes, parsed.cover.mediaType);
          if (source) {
            try {
              const directory = await this._coverDirectory(true);
              await fs.writeFile(
                path.join(directory, `${bookId}.img`),
                parsed.cover.bytes,
                { flag: 'wx', mode: 0o600 },
              );
              const latest = await this._catalog();
              const books = latest.data.books.map((item) =>
                item.bookId === bookId
                  ? { ...item, coverMimeType: parsed.cover.mediaType }
                  : item,
              );
              await this.store.save(
                'library',
                { ...latest.data, books },
                latest.revision,
              );
            } catch {
              // Keep the verified cover usable for this session if caching fails.
            }
          }
        }
      }
    }
    return source;
  }
  async remove(bookId, keepNotes) {
    const catalog = await this._catalog();
    const index = catalog.data.books.findIndex(
      (book) => book.bookId === bookId,
    );
    if (index < 0) fail('NOT_FOUND', '找不到这本书。');
    const book = catalog.data.books[index];
    if (!validStoredBookName(book))
      fail('INVALID_BOOK', '书籍文件记录无效，未执行删除。');
    const booksDirectory = await this._booksDirectory();
    const coversDirectory = await this._coverDirectory();
    const books = keepNotes
      ? [...catalog.data.books]
      : catalog.data.books.filter((item) => item.bookId !== bookId);
    if (keepNotes)
      books[index] = {
        ...book,
        fileStatus: 'removed',
        removedAt: new Date().toISOString(),
      };
    // Keep catalog and reading state available for retry until private-file cleanup succeeds.
    if (booksDirectory) {
      const ownedFiles = (await fs.readdir(booksDirectory)).filter((fileName) =>
        validStoredBookName({ ...book, fileName }),
      );
      for (const fileName of ownedFiles)
        await fs.rm(path.join(booksDirectory, fileName), { force: true });
    }
    if (coversDirectory)
      await fs.rm(path.join(coversDirectory, `${book.bookId}.img`), {
        force: true,
      });
    if (!keepNotes) {
      await this.store.remove(`reading-${book.bookId}`);
      await this.store.remove(`annotations-${book.bookId}`);
      await this.store.remove(`note-${book.bookId}`);
    }
    await this.store.save('library', { books }, catalog.revision);
    return keepNotes ? books[index] : book;
  }
}
module.exports = {
  LibraryManager,
  LibraryError,
  parseEpub: safeParseEpub,
  parseTxt,
  decodeTxt,
  comparablePath,
  validStoredBookName,
};
