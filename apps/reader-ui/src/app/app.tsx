import { useEffect, useMemo, useState } from 'react';
import styles from './app.module.css';

type Book = {
  bookId: string;
  title: string;
  author: string;
  format: 'epub' | 'txt';
  importedAt: string;
  lastReadAt: string | null;
  fileStatus: 'available' | 'removed';
  chapters: { id: string; title: string }[];
  encoding: string | null;
};
type ImportResult = Book | { error: string; fileName: string };

declare global {
  interface Window {
    reader: {
      libraryList(): Promise<Book[]>;
      libraryImport(): Promise<ImportResult[]>;
      libraryRemove(id: string, keepNotes: boolean): Promise<Book>;
    };
  }
}

type Sort = 'title' | 'author' | 'recent' | 'imported';

export function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [sort, setSort] = useState<Sort>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<Book | null>(null);
  const refresh = async () => setBooks(await window.reader.libraryList());
  useEffect(() => {
    void refresh();
  }, []);
  const sorted = useMemo(
    () =>
      [...books].sort((a, b) => {
        if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
        if (sort === 'author') return a.author.localeCompare(b.author, 'zh-CN');
        if (sort === 'imported')
          return b.importedAt.localeCompare(a.importedAt);
        return (b.lastReadAt || b.importedAt).localeCompare(
          a.lastReadAt || a.importedAt,
        );
      }),
    [books, sort],
  );
  const importBooks = async () => {
    setBusy(true);
    setMessage('');
    try {
      const results = await window.reader.libraryImport();
      const failures = results.filter(
        (item): item is { error: string; fileName: string } => 'error' in item,
      );
      if (failures.length)
        setMessage(
          failures.map((item) => `${item.fileName}：${item.error}`).join('；'),
        );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败。');
    } finally {
      setBusy(false);
    }
  };
  const removeBook = async (book: Book, keepNotes: boolean) => {
    try {
      await window.reader.libraryRemove(book.bookId, keepNotes);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败。');
    } finally {
      setRemoving(null);
    }
  };
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>本地阅读器</p>
          <h1>书架</h1>
          <p className={styles.muted}>
            {books.length ? `${books.length} 本书` : '导入一本书，开始阅读。'}
          </p>
        </div>
        <button
          className={styles.primary}
          onClick={() => void importBooks()}
          disabled={busy}
        >
          {busy ? '导入中…' : '导入书籍'}
        </button>
      </header>
      <section className={styles.toolbar} aria-label="书架工具">
        <label>
          排序{' '}
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
          >
            <option value="recent">最近阅读</option>
            <option value="imported">导入时间</option>
            <option value="title">书名</option>
            <option value="author">作者</option>
          </select>
        </label>
        <div className={styles.viewSwitch}>
          <button
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
          >
            封面
          </button>
          <button
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            列表
          </button>
        </div>
      </section>
      {message && (
        <p className={styles.notice} role="alert">
          {message}
        </p>
      )}
      {removing && (
        <div
          className={styles.backdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRemoving(null);
          }}
        >
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-title"
          >
            <h2 id="remove-title">删除“{removing.title}”</h2>
            <p>书籍文件将从应用数据目录移除。外部原始文件不会被删除。</p>
            <button
              className={styles.primary}
              onClick={() => void removeBook(removing, true)}
            >
              仅移除书文件，保留笔记
            </button>
            <button
              className={styles.danger}
              onClick={() => void removeBook(removing, false)}
            >
              删除书籍及用户内容
            </button>
            <button className={styles.cancel} onClick={() => setRemoving(null)}>
              取消
            </button>
          </section>
        </div>
      )}
      {!sorted.length ? (
        <section className={styles.empty}>
          <div className={styles.emptyMark}>+</div>
          <h2>书架还是空的</h2>
          <p>支持 EPUB 和 UTF-8、GBK 编码的 TXT 文件。</p>
          <button className={styles.primary} onClick={() => void importBooks()}>
            选择文件
          </button>
        </section>
      ) : (
        <section className={view === 'grid' ? styles.grid : styles.list}>
          {sorted.map((book) => (
            <article className={styles.book} key={book.bookId}>
              <div className={styles.cover}>
                <span>{book.format.toUpperCase()}</span>
              </div>
              <div className={styles.bookInfo}>
                <h2>{book.title}</h2>
                <p>{book.author}</p>
                <small>
                  {book.chapters.length
                    ? `${book.chapters.length} 个章节`
                    : '整本阅读'}
                </small>
              </div>
              <button
                className={styles.remove}
                title="删除书籍"
                onClick={() => setRemoving(book)}
              >
                删除
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
export default App;
