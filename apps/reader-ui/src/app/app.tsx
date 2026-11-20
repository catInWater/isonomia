import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  BookSummary,
  ImportFailure,
  OpenedBook,
  ReaderChapter,
  ReaderImage,
  ReaderLink,
  ReadingPosition,
  ReadingPreferences,
  ReadingRange,
  StorageBridge,
} from '@reader/storage-bridge';
import styles from './app.module.css';
import annotationStyles from './annotations.module.css';
import { makePages, safeBoundary, pageForPosition } from './pagination';
import { bookImageStyle, contentRuns } from './book-content';
import type { ContentDecoration } from './book-content';
import { AnnotationPanel, useBookAnnotations } from './annotations';
import type { AnnotationItem, AnnotationView } from './annotations';
import { NotePanel } from './notes';
import {
  comparePositions,
  readSelection,
  selectionPreview,
} from './reading-selection';

declare global {
  interface Window {
    reader: StorageBridge;
  }
}

type Sort = 'title' | 'author' | 'recent' | 'imported';
type ReaderStyle = CSSProperties & Record<`--${string}`, string | number>;

const SAFE_IMAGE_DATA_URL =
  /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const isSafeImageDataUrl = (value: string) =>
  value.length <= 2_800_000 && SAFE_IMAGE_DATA_URL.test(value);

const DEFAULT_PREFERENCES: ReadingPreferences = {
  mode: 'scroll',
  fontSize: 18,
  lineHeight: 1.6,
  theme: 'light',
  pageMargin: 24,
  fontFamily: 'default',
};

function estimatePageCapacity(
  fontSize: number,
  lineHeight: number,
  viewport: { width: number; height: number },
) {
  const width = Math.max(320, Math.min(viewport.width - 96, 720));
  const height = Math.max(
    300,
    Math.min(viewport.height - 230, viewport.height * 0.68, 800),
  );
  const charsPerLine = Math.max(20, Math.floor(width / fontSize));
  const lines = Math.max(10, Math.floor(height / (fontSize * lineHeight)));
  return Math.max(400, Math.min(6000, charsPerLine * lines * 0.88));
}

function BookImage({ image }: { image: ReaderImage }) {
  const { src, alt, inline } = image;
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span
        className={inline ? styles.inlineImageFallback : styles.imageFallback}
      >
        {alt || '[图片无法显示]'}
      </span>
    );
  return (
    <img
      className={inline ? styles.inlineBookImage : styles.bookImage}
      src={src}
      alt={alt}
      width={image.width}
      height={image.height}
      style={bookImageStyle(image)}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function renderImageAwareText(
  text: string,
  images: ReaderImage[],
  startOffset = 0,
  instanceKey = '',
  links: ReaderLink[] = [],
  onNavigate?: (target: ReadingPosition) => void,
  decorations: ContentDecoration[] = [],
  onHighlight?: (highlightId: string) => void,
): ReactNode[] {
  return contentRuns(text, images, links, startOffset, decorations).map(
    (run) => {
      const image = run.image;
      const key = `${instanceKey}-${run.offset}`;
      const content = (
        <span
          key={key}
          data-content-start={run.offset}
          data-content-length={run.length}
          data-emphasis={run.emphasis}
        >
          {image ? (
            isSafeImageDataUrl(image.src) ? (
              <BookImage image={image} />
            ) : (
              <span
                className={
                  image.inline
                    ? styles.inlineImageFallback
                    : styles.imageFallback
                }
              >
                {image.alt || '[图片无法显示]'}
              </span>
            )
          ) : (
            run.text
          )}
        </span>
      );
      const target = run.target;
      const highlightId = run.highlight?.highlightId;
      const openHighlight = () => {
        if (highlightId) onHighlight?.(highlightId);
      };
      const highlightAttributes = {
        'data-highlight-id': highlightId,
        'data-highlight-color': run.highlight?.color,
      };
      if (target && onNavigate)
        return (
          <a
            key={key}
            className={styles.bookLink}
            href={`#reader-${target.chapterId}-${target.blockIndex}-${target.offset}`}
            {...highlightAttributes}
            title={
              highlightId ? '打开批注；Alt + 点击可跟随原书链接' : undefined
            }
            onClick={(event) => {
              event.preventDefault();
              if (window.getSelection()?.isCollapsed === false) return;
              if (highlightId && !event.altKey) openHighlight();
              else onNavigate(target);
            }}
            onKeyDown={(event) => {
              if (highlightId && event.altKey && event.key === 'Enter') {
                event.preventDefault();
                onNavigate(target);
              }
            }}
          >
            {content}
          </a>
        );
      if (highlightId)
        return (
          <span
            key={key}
            role="button"
            tabIndex={0}
            {...highlightAttributes}
            title="打开批注"
            onClick={() => {
              if (window.getSelection()?.isCollapsed !== false) openHighlight();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openHighlight();
              }
            }}
          >
            {content}
          </span>
        );
      return content;
    },
  );
}

function BookCover({ book }: { book: BookSummary }) {
  const [src, setSrc] = useState<string | null>(null);
  const [inRange, setInRange] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ((!book.coverMimeType && book.format !== 'epub') || !container.current)
      return;
    if (typeof IntersectionObserver === 'undefined') {
      setInRange(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInRange(true);
          observer.disconnect();
        }
      },
      { rootMargin: '180px' },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [book.bookId, book.coverMimeType, book.format]);

  useEffect(() => {
    if (!inRange || (!book.coverMimeType && book.format !== 'epub')) return;
    let active = true;
    void window.reader
      .libraryCover(book.bookId)
      .then((image) => {
        if (active && image && isSafeImageDataUrl(image)) setSrc(image);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [book.bookId, book.coverMimeType, book.format, inRange]);

  return (
    <div className={styles.cover} ref={container}>
      {src ? (
        <img
          src={src}
          alt={`${book.title}封面`}
          loading="lazy"
          decoding="async"
          onError={() => setSrc(null)}
        />
      ) : (
        <span>{book.format.toUpperCase()}</span>
      )}
    </div>
  );
}

export function App() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [sort, setSort] = useState<Sort>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<BookSummary | null>(null);
  const [opened, setOpened] = useState<OpenedBook | null>(null);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [position, setPosition] = useState<ReadingPosition | null>(null);
  const [preferences, setPreferences] =
    useState<ReadingPreferences>(DEFAULT_PREFERENCES);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [annotationView, setAnnotationView] = useState<AnnotationView | null>(
    null,
  );
  const [shelfAnnotations, setShelfAnnotations] = useState<BookSummary | null>(
    null,
  );
  const [selection, setSelection] = useState<ReadingRange | null>(null);
  const [crossStart, setCrossStart] = useState<ReadingRange | null>(null);
  const [jumpRange, setJumpRange] = useState<ReadingRange | null>(null);
  const annotationBook = opened?.book || shelfAnnotations;
  const annotations = useBookAnnotations(annotationBook);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const readingArea = useRef<HTMLElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restorePending = useRef(true);
  const linkFocusPending = useRef(false);
  const focusBeforeMode = useRef<HTMLElement | null>(null);

  const clearSelection = useCallback(() => {
    setSelection(null);
    if (
      readingArea.current?.contains(window.getSelection()?.anchorNode ?? null)
    )
      window.getSelection()?.removeAllRanges();
  }, []);
  useEffect(() => {
    if (!chapter) return;
    const onSelection = () => {
      const area = readingArea.current;
      if (!area) return;
      setSelection(readSelection(area, chapter));
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [chapter]);

  const refresh = useCallback(async () => {
    setBooks(await window.reader.libraryList());
  }, []);
  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : '无法读取书架。'),
    );
  }, [refresh]);
  useEffect(() => {
    const onResize = () => {
      restorePending.current = true;
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const sorted = useMemo(
    () =>
      books
        .filter((book) => book.fileStatus === 'available')
        .sort((a, b) => {
          if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
          if (sort === 'author')
            return a.author.localeCompare(b.author, 'zh-CN');
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
        (item): item is ImportFailure => 'error' in item,
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

  const showShelfAnnotations = (book: BookSummary) => {
    setShelfAnnotations(book);
    setAnnotationView({ kind: 'list' });
    requestAnimationFrame(() =>
      document
        .getElementById('retained-annotations')
        ?.scrollIntoView({ block: 'start' }),
    );
  };

  const replaceBook = async (book: BookSummary) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await window.reader.libraryReplace(book.bookId);
      if (!result) return;
      setShelfAnnotations(null);
      setAnnotationView(null);
      await refresh();
      setMessage('正文已替换，原划线与批注仍保留。打开书籍可查看定位结果。');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '替换正文失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const removeBook = async (book: BookSummary, keepNotes: boolean) => {
    try {
      const removed = await window.reader.libraryRemove(book.bookId, keepNotes);
      if (keepNotes) showShelfAnnotations(removed);
      else if (shelfAnnotations?.bookId === book.bookId) {
        setShelfAnnotations(null);
        setAnnotationView(null);
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败。');
    } finally {
      setRemoving(null);
    }
  };

  const persistReading = useCallback(
    async (nextPosition: ReadingPosition, nextPreferences = preferences) => {
      if (!opened) return;
      setSaving(true);
      try {
        const result = await window.reader.saveReading({
          bookId: opened.book.bookId,
          contentHash: opened.book.contentHash,
          position: nextPosition,
          preferences: nextPreferences,
        });
        setBooks((items) =>
          items.map((book) =>
            book.bookId === opened.book.bookId
              ? { ...book, lastReadAt: result.lastReadAt }
              : book,
          ),
        );
        setSaveFailed(false);
        setMessage('');
      } catch (error) {
        setSaveFailed(true);
        setMessage(
          `阅读进度未保存：${error instanceof Error ? error.message : '请重试。'}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [opened, preferences],
  );

  const queueSave = useCallback(
    (nextPosition: ReadingPosition, nextPreferences = preferences) => {
      setPosition(nextPosition);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void persistReading(nextPosition, nextPreferences);
      }, 650);
    },
    [persistReading, preferences],
  );

  const captureScrollPosition = useCallback((): ReadingPosition | null => {
    const area = readingArea.current;
    if (!area || !chapter) return null;
    const blocks = Array.from(
      area.querySelectorAll<HTMLElement>('[data-block-index]'),
    );
    const visible =
      blocks.find(
        (block) =>
          block.getBoundingClientRect().bottom >
          area.getBoundingClientRect().top + 24,
      ) || blocks[blocks.length - 1];
    if (!visible) return null;
    const rect = visible.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (area.getBoundingClientRect().top + 24 - rect.top) /
          Math.max(rect.height, 1),
      ),
    );
    return {
      chapterId: chapter.id,
      blockIndex: Number(visible.dataset.blockIndex),
      offset: safeBoundary(
        chapter.blocks[Number(visible.dataset.blockIndex)] || '',
        Math.round(fraction * Number(visible.dataset.blockLength || 0)),
      ),
    };
  }, [chapter]);

  const closeReader = async () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    scrollTimer.current = null;
    saveTimer.current = null;
    const current =
      preferences.mode === 'scroll'
        ? captureScrollPosition() || position
        : position;
    if (current) await persistReading(current);
    clearSelection();
    setCrossStart(null);
    setJumpRange(null);
    setAnnotationView(null);
    setOpened(null);
    setChapter(null);
    void refresh();
  };

  const openBook = async (book: BookSummary) => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    scrollTimer.current = null;
    saveTimer.current = null;
    if (opened && position) {
      const previous =
        preferences.mode === 'scroll'
          ? captureScrollPosition() || position
          : position;
      await persistReading(previous);
    }
    setBusy(true);
    setMessage('');
    setSaveFailed(false);
    try {
      const result = await window.reader.openBook({ bookId: book.bookId });
      const firstChapter = result.book.chapters[0];
      if (!firstChapter) throw new Error('这本书没有可阅读的章节。');
      const chapterId = result.book.chapters.some(
        (item) => item.id === result.position.chapterId,
      )
        ? result.position.chapterId
        : firstChapter.id;
      const chapterResult = await window.reader.readChapter({
        bookId: result.book.bookId,
        chapterId,
      });
      const restoredPosition =
        chapterId === result.position.chapterId
          ? result.position
          : { chapterId, blockIndex: 0, offset: 0 };
      clearSelection();
      setCrossStart(null);
      setJumpRange(null);
      setAnnotationView(null);
      setShelfAnnotations(null);
      setOpened(result);
      setBooks((items) =>
        items.map((item) =>
          item.bookId === result.book.bookId ? result.book : item,
        ),
      );
      setPreferences(result.preferences || DEFAULT_PREFERENCES);
      setPosition(restoredPosition);
      setChapter(chapterResult);
      setPageIndex(0);
      restorePending.current = true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法打开这本书。');
    } finally {
      setBusy(false);
    }
  };

  const loadChapter = useCallback(
    async (chapterId: string, nextPosition?: ReadingPosition) => {
      if (!opened) return;
      if (scrollTimer.current) {
        clearTimeout(scrollTimer.current);
        scrollTimer.current = null;
      }
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (position && position.chapterId !== chapterId)
        await persistReading(position);
      setBusy(true);
      try {
        const nextChapter = await window.reader.readChapter({
          bookId: opened.book.bookId,
          chapterId,
        });
        clearSelection();
        setCrossStart(null);
        setChapter(nextChapter);
        setPageIndex(0);
        restorePending.current = true;
        const next = nextPosition || { chapterId, blockIndex: 0, offset: 0 };
        setPosition(next);
        void persistReading(next);
        return true;
      } catch (error) {
        linkFocusPending.current = false;
        setMessage(error instanceof Error ? error.message : '无法打开此章节。');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [opened, position, persistReading, clearSelection],
  );

  const followBookLink = (target: ReadingPosition) => {
    linkFocusPending.current = true;
    void loadChapter(target.chapterId, target);
  };

  const pages = useMemo(
    () =>
      chapter
        ? makePages(
            chapter,
            estimatePageCapacity(
              preferences.fontSize,
              preferences.lineHeight,
              viewport,
            ),
          )
        : [],
    [chapter, preferences.fontSize, preferences.lineHeight, viewport],
  );
  const pageCount = Math.max(1, pages.length);
  const selectedRange =
    selection &&
    (!crossStart || comparePositions(crossStart.end, selection.start) <= 0)
      ? { start: crossStart?.start ?? selection.start, end: selection.end }
      : null;
  const decorations = useMemo(() => {
    const byBlock = new Map<number, ContentDecoration[]>();
    if (!chapter) return byBlock;
    const add = (
      range: ReadingRange,
      detail: Omit<ContentDecoration, 'offset' | 'length'>,
    ) => {
      if (
        range.start.chapterId !== chapter.id ||
        range.end.chapterId !== chapter.id
      )
        return;
      for (
        let index = range.start.blockIndex;
        index <= range.end.blockIndex;
        index++
      ) {
        const offset =
          index === range.start.blockIndex ? range.start.offset : 0;
        const end =
          index === range.end.blockIndex
            ? range.end.offset
            : chapter.blocks[index]?.length;
        if (end === undefined || end <= offset) continue;
        if (!byBlock.has(index)) byBlock.set(index, []);
        byBlock.get(index)?.push({ ...detail, offset, length: end - offset });
      }
    };
    for (const item of annotations.snapshot?.items ?? []) {
      if (item.resolution.status !== 'lost')
        add(item.resolution.range, {
          highlightId: item.highlightId,
          color: item.color,
        });
    }
    if (annotationView?.kind === 'create')
      add(annotationView.range, { emphasis: 'preview' });
    if (jumpRange) add(jumpRange, { emphasis: 'jump' });
    return byBlock;
  }, [annotations.snapshot, annotationView, chapter, jumpRange]);

  const showHighlight = (highlightId: string) => {
    if (annotations.busy) return;
    setFocusMode(false);
    setAnnotationView({ kind: 'detail', highlightId });
  };
  const jumpToAnnotation = async ({ resolution }: AnnotationItem) => {
    if (resolution.status === 'lost') return;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    const { range } = resolution;
    linkFocusPending.current = true;
    setJumpRange(range);
    if (!(await loadChapter(range.start.chapterId, range.start))) {
      setJumpRange(null);
      return;
    }
    jumpTimer.current = setTimeout(() => setJumpRange(null), 1800);
  };
  const closeAnnotations = () => {
    setAnnotationView(null);
    setShelfAnnotations(null);
    if (opened)
      requestAnimationFrame(() =>
        document
          .getElementById('reader-annotations')
          ?.focus({ preventScroll: true }),
      );
  };

  const writeAnnotation = () => {
    if (!chapter || !selectedRange) return;
    setAnnotationView({
      kind: 'create',
      range: selectedRange,
      quote: selectionPreview(chapter, selectedRange),
    });
    clearSelection();
    setCrossStart(null);
  };
  const quickHighlight = async () => {
    if (!selectedRange || !opened) return;
    const result = await annotations.change({
      kind: 'create',
      color: 'yellow',
      text: '',
      range: selectedRange,
      contentHash: opened.book.contentHash,
    });
    if (result) {
      clearSelection();
      setCrossStart(null);
    } else setAnnotationView((current) => current ?? { kind: 'list' });
  };

  useEffect(() => {
    if (!chapter || !position || !restorePending.current) return;
    if (preferences.mode === 'paginated') {
      setPageIndex(pageForPosition(pages, position, chapter.blocks));
      restorePending.current = false;
      if (linkFocusPending.current)
        requestAnimationFrame(() => {
          const target = readingArea.current?.querySelector<HTMLElement>(
            `[data-block-index="${position.blockIndex}"]`,
          );
          const emphasized = target?.querySelector<HTMLElement>(
            '[data-emphasis="jump"]',
          );
          emphasized?.scrollIntoView({ block: 'center' });
          target?.focus({ preventScroll: true });
          linkFocusPending.current = false;
        });
      return;
    }
    requestAnimationFrame(() => {
      const scroller = readingArea.current;
      const target = scroller?.querySelector<HTMLElement>(
        `[data-block-index="${position.blockIndex}"]`,
      );
      if (!scroller || !target) return;
      const fraction = target.dataset.blockLength
        ? Math.min(1, position.offset / Number(target.dataset.blockLength))
        : 0;
      let targetTop =
        target.getBoundingClientRect().top + target.offsetHeight * fraction;
      const runs = Array.from(
        target.querySelectorAll<HTMLElement>('[data-content-start]'),
      );
      const run =
        runs.find(
          (element) =>
            position.offset >= Number(element.dataset.contentStart) &&
            position.offset <
              Number(element.dataset.contentStart) +
                Number(element.dataset.contentLength),
        ) || runs[runs.length - 1];
      if (run) {
        const node = run.firstChild;
        if (node?.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();
          const offset = Math.max(
            0,
            Math.min(
              node.textContent?.length || 0,
              position.offset - Number(run.dataset.contentStart),
            ),
          );
          range.setStart(node, offset);
          range.setEnd(
            node,
            Math.min(node.textContent?.length || 0, offset + 1),
          );
          const rect = range.getBoundingClientRect();
          if (rect.height > 0) targetTop = rect.top;
        } else
          targetTop = (run.querySelector('img') || run).getBoundingClientRect()
            .top;
      }
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollTop +
          targetTop -
          scroller.getBoundingClientRect().top -
          8,
      );
      if (linkFocusPending.current) {
        target.focus({ preventScroll: true });
        linkFocusPending.current = false;
      }
      restorePending.current = false;
    });
  }, [
    chapter,
    pages,
    position,
    preferences.mode,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.pageMargin,
    preferences.fontFamily,
  ]);

  useEffect(() => {
    if (!opened || !chapter || preferences.mode !== 'scroll') return;
    const area = readingArea.current;
    if (!area) return;
    const onScroll = () => {
      if (restorePending.current) return;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {
        const next = captureScrollPosition();
        if (next) queueSave(next);
      }, 180);
    };
    area.addEventListener('scroll', onScroll, { passive: true });
    return () => area.removeEventListener('scroll', onScroll);
  }, [opened, chapter, preferences.mode, queueSave, captureScrollPosition]);

  const updatePreferences = (patch: Partial<ReadingPreferences>) => {
    const previousMode = preferences.mode;
    const next = { ...preferences, ...patch };
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    scrollTimer.current = null;
    saveTimer.current = null;
    const current =
      previousMode === 'scroll'
        ? captureScrollPosition() || position
        : position;
    if (current) setPosition(current);
    setPreferences(next);
    restorePending.current = true;
    if (patch.mode && patch.mode !== previousMode) {
      setPageIndex(0);
      clearSelection();
      setCrossStart(null);
    }
    if (current) void persistReading(current, next);
  };

  const stepPage = useCallback(
    (direction: -1 | 1) => {
      if (!opened || !chapter) return;
      if (preferences.mode === 'scroll') {
        const area = readingArea.current;
        if (!area) return;
        const atStart = area.scrollTop <= 2;
        const atEnd =
          area.scrollTop + area.clientHeight >= area.scrollHeight - 2;
        if ((direction < 0 && atStart) || (direction > 0 && atEnd)) {
          const chapterIndex = opened.book.chapters.findIndex(
            (item) => item.id === chapter.id,
          );
          const next = opened.book.chapters[chapterIndex + direction];
          if (next) {
            if (direction < 0) {
              void window.reader
                .readChapter({ bookId: opened.book.bookId, chapterId: next.id })
                .then((result) => {
                  const blockIndex = Math.max(0, result.blocks.length - 1);
                  const block = result.blocks[blockIndex] || '';
                  return loadChapter(next.id, {
                    chapterId: next.id,
                    blockIndex,
                    offset: safeBoundary(block, block.length),
                  });
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error ? error.message : '无法打开此章节。',
                  ),
                );
            } else void loadChapter(next.id);
          }
          return;
        }
        area.scrollBy({
          top: direction * area.clientHeight * 0.85,
          behavior: 'smooth',
        });
        return;
      }
      const nextPage = pageIndex + direction;
      if (nextPage >= 0 && nextPage < pageCount) {
        clearSelection();
        setPageIndex(nextPage);
        const first = pages[nextPage]?.[0];
        if (first)
          queueSave({
            chapterId: chapter.id,
            blockIndex: first.blockIndex,
            offset: first.start,
          });
        return;
      }
      const chapterIndex = opened.book.chapters.findIndex(
        (item) => item.id === chapter.id,
      );
      const next = opened.book.chapters[chapterIndex + direction];
      if (next) {
        if (direction < 0) {
          void window.reader
            .readChapter({ bookId: opened.book.bookId, chapterId: next.id })
            .then((result) => {
              const blockIndex = Math.max(0, result.blocks.length - 1);
              const block = result.blocks[blockIndex] || '';
              return loadChapter(next.id, {
                chapterId: next.id,
                blockIndex,
                offset: safeBoundary(block, block.length),
              });
            })
            .catch((error: unknown) =>
              setMessage(
                error instanceof Error ? error.message : '无法打开此章节。',
              ),
            );
        } else void loadChapter(next.id);
      }
    },
    [
      opened,
      chapter,
      pageIndex,
      pageCount,
      pages,
      queueSave,
      loadChapter,
      preferences.mode,
      clearSelection,
    ],
  );

  useEffect(() => {
    if (!opened) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))
      )
        return;
      if (event.key === 'Escape' && focusMode) {
        setFocusMode(false);
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        stepPage(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        stepPage(-1);
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        document.getElementById('reader-toc')?.focus();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFocusMode((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [opened, chapter, pageIndex, pageCount, focusMode, pages, stepPage]);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );

  const toggleFocus = () => {
    if (!focusMode)
      focusBeforeMode.current = document.activeElement as HTMLElement;
    setFocusMode((value) => !value);
    if (focusMode)
      requestAnimationFrame(() => focusBeforeMode.current?.focus());
  };

  if (opened && chapter) {
    const themeClass =
      preferences.theme === 'dark'
        ? styles.dark
        : preferences.theme === 'sepia'
          ? styles.sepia
          : styles.light;
    const typographyStyle: ReaderStyle = {
      fontSize: `${preferences.fontSize}px`,
      lineHeight: preferences.lineHeight,
      '--page-margin': `${preferences.pageMargin}px`,
      fontFamily:
        preferences.fontFamily === 'serif'
          ? 'Georgia, "Noto Serif CJK SC", "Songti SC", serif'
          : preferences.fontFamily === 'sans-serif'
            ? 'Arial, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
            : preferences.fontFamily === 'monospace'
              ? 'ui-monospace, "Noto Sans Mono CJK SC", monospace'
              : '"Segoe UI", "Microsoft YaHei", sans-serif',
    };
    const chapterIndex = opened.book.chapters.findIndex(
      (item) => item.id === chapter.id,
    );
    return (
      <main
        className={`${styles.readerShell} ${themeClass} ${focusMode ? styles.focusMode : ''}`}
      >
        {!focusMode && (
          <header className={styles.readerHeader}>
            <button
              className={styles.backButton}
              onClick={() => void closeReader()}
            >
              ← <span>书架</span>
            </button>
            <div className={styles.readerBookTitle}>
              <strong>{opened.book.title}</strong>
              <span>{chapter.title}</span>
            </div>
            <div className={styles.saveState} role="status">
              {saving ? '保存中…' : saveFailed ? '保存失败' : '进度已保存'}
            </div>
          </header>
        )}
        <div className={styles.readerLayout} style={typographyStyle}>
          {!focusMode &&
            (annotationView ? (
              <aside className={styles.annotationAside}>
                <AnnotationPanel
                  book={opened.book}
                  controller={annotations}
                  view={annotationView}
                  setView={setAnnotationView}
                  close={closeAnnotations}
                  jump={jumpToAnnotation}
                />
              </aside>
            ) : (
              <aside className={styles.toc} aria-label="目录">
                <p>目录</p>
                <nav id="reader-toc" tabIndex={-1}>
                  {opened.book.chapters.map((item, index) => (
                    <button
                      key={item.id}
                      className={
                        item.id === chapter.id ? styles.activeChapter : ''
                      }
                      onClick={() => void loadChapter(item.id)}
                    >
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      {item.title}
                    </button>
                  ))}
                </nav>
              </aside>
            ))}
          {!focusMode && <NotePanel bookId={opened.book.bookId} />}
          <section className={styles.readingColumn}>
            {!focusMode && (
              <div className={styles.readerToolbar}>
                <div className={styles.modeSwitch} aria-label="阅读模式">
                  <button
                    aria-pressed={preferences.mode === 'scroll'}
                    onClick={() => updatePreferences({ mode: 'scroll' })}
                  >
                    滚动
                  </button>
                  <button
                    aria-pressed={preferences.mode === 'paginated'}
                    onClick={() => updatePreferences({ mode: 'paginated' })}
                  >
                    分页
                  </button>
                </div>
                <div className={styles.readingControls}>
                  <button
                    aria-label="缩小字号"
                    title="缩小字号"
                    onClick={() =>
                      updatePreferences({
                        fontSize: Math.max(12, preferences.fontSize - 1),
                      })
                    }
                  >
                    A−
                  </button>
                  <span>{preferences.fontSize}px</span>
                  <button
                    aria-label="增大字号"
                    title="增大字号"
                    onClick={() =>
                      updatePreferences({
                        fontSize: Math.min(36, preferences.fontSize + 1),
                      })
                    }
                  >
                    A+
                  </button>
                  <label>
                    行距{' '}
                    <select
                      value={preferences.lineHeight}
                      onChange={(event) =>
                        updatePreferences({
                          lineHeight: Number(event.target.value),
                        })
                      }
                    >
                      <option value="1.2">紧凑</option>
                      <option value="1.5">舒适</option>
                      <option value="1.6">标准</option>
                      <option value="2">宽松</option>
                      <option value="2.4">最大</option>
                    </select>
                  </label>
                  <label>
                    边距{' '}
                    <select
                      className={styles.marginSelect}
                      value={preferences.pageMargin}
                      onChange={(event) =>
                        updatePreferences({
                          pageMargin: Number(event.target.value),
                        })
                      }
                    >
                      <option value="12">窄</option>
                      <option value="24">标准</option>
                      <option value="40">宽</option>
                      <option value="64">最宽</option>
                    </select>
                  </label>
                  <label>
                    字体{' '}
                    <select
                      value={preferences.fontFamily}
                      onChange={(event) =>
                        updatePreferences({
                          fontFamily: event.target
                            .value as ReadingPreferences['fontFamily'],
                        })
                      }
                    >
                      <option value="default">系统</option>
                      <option value="serif">宋体</option>
                      <option value="sans-serif">无衬线</option>
                      <option value="monospace">等宽</option>
                    </select>
                  </label>
                </div>
                <div className={styles.themeSwitch} aria-label="主题">
                  <button
                    title="浅色"
                    aria-label="浅色主题"
                    aria-pressed={preferences.theme === 'light'}
                    onClick={() => updatePreferences({ theme: 'light' })}
                  >
                    ☼
                  </button>
                  <button
                    title="护眼"
                    aria-label="护眼主题"
                    aria-pressed={preferences.theme === 'sepia'}
                    onClick={() => updatePreferences({ theme: 'sepia' })}
                  >
                    ◐
                  </button>
                  <button
                    title="深色"
                    aria-label="深色主题"
                    aria-pressed={preferences.theme === 'dark'}
                    onClick={() => updatePreferences({ theme: 'dark' })}
                  >
                    ☾
                  </button>
                  <button title="专注模式 (F)" onClick={toggleFocus}>
                    专注
                  </button>
                </div>
                <div className={styles.annotationActions} aria-label="选区操作">
                  <button
                    id="reader-annotations"
                    aria-expanded={!!annotationView}
                    disabled={annotations.busy}
                    onClick={() =>
                      annotationView
                        ? closeAnnotations()
                        : setAnnotationView({ kind: 'list' })
                    }
                  >
                    全书划线
                  </button>
                  {selectedRange && (
                    <>
                      <button
                        disabled={!annotations.canChange || busy}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void quickHighlight()}
                      >
                        划线
                      </button>
                      <button
                        disabled={!annotations.canChange || busy}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={writeAnnotation}
                      >
                        写批注
                      </button>
                      {!crossStart &&
                        preferences.mode === 'paginated' &&
                        pageIndex + 1 < pageCount && (
                          <button
                            disabled={busy}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setCrossStart(selectedRange);
                              stepPage(1);
                            }}
                          >
                            跨页选取
                          </button>
                        )}
                    </>
                  )}
                  {crossStart ? (
                    <>
                      <span role="status">
                        已保留起点，请在同章后续页选择终点。
                      </span>
                      <button
                        onClick={() => {
                          setCrossStart(null);
                          clearSelection();
                        }}
                      >
                        取消跨页选取
                      </button>
                    </>
                  ) : (
                    !selectedRange && <span>选中文字后可划线或写批注</span>
                  )}
                </div>
              </div>
            )}
            <div className={styles.chapterHeading}>
              <span>第 {chapterIndex + 1} 章</span>
              <h1>{chapter.title}</h1>
            </div>
            {preferences.mode === 'scroll' ? (
              <article
                ref={readingArea}
                className={styles.scrollContent}
                style={typographyStyle}
                aria-label="正文"
              >
                {chapter.blocks.map((block, index) => (
                  <p
                    key={`${chapter.id}-${index}`}
                    data-block-index={index}
                    data-block-length={block.length}
                    tabIndex={-1}
                  >
                    {renderImageAwareText(
                      block,
                      (chapter.images || []).filter(
                        (image) => image.blockIndex === index,
                      ),
                      0,
                      chapter.id,
                      (chapter.links || []).filter(
                        (link) => link.blockIndex === index,
                      ),
                      followBookLink,
                      decorations.get(index),
                      showHighlight,
                    )}
                    {!block && ' '}
                  </p>
                ))}
              </article>
            ) : (
              <>
                <article
                  ref={readingArea}
                  className={styles.pageContent}
                  style={typographyStyle}
                  aria-label="正文"
                  aria-live="polite"
                >
                  {(pages[pageIndex] || []).map((part, index) => (
                    <p
                      key={`${part.blockIndex}-${part.start}-${index}`}
                      data-block-index={part.blockIndex}
                      data-page-block={part.blockIndex}
                      tabIndex={-1}
                    >
                      {renderImageAwareText(
                        part.text,
                        (chapter.images || []).filter(
                          (image) =>
                            image.blockIndex === part.blockIndex &&
                            image.offset >= part.start &&
                            image.offset < part.start + part.text.length,
                        ),
                        part.start,
                        `${chapter.id}-${pageIndex}`,
                        (chapter.links || []).filter(
                          (link) => link.blockIndex === part.blockIndex,
                        ),
                        followBookLink,
                        decorations.get(part.blockIndex),
                        showHighlight,
                      )}
                    </p>
                  ))}
                </article>
                <div className={styles.pageNav}>
                  <button
                    onClick={() => stepPage(-1)}
                    disabled={chapterIndex === 0 && pageIndex === 0}
                  >
                    上一页
                  </button>
                  <span>
                    第 {pageIndex + 1} / {pageCount} 页
                  </span>
                  <button
                    onClick={() => stepPage(1)}
                    disabled={
                      chapterIndex === opened.book.chapters.length - 1 &&
                      pageIndex >= pageCount - 1
                    }
                  >
                    下一页
                  </button>
                </div>
              </>
            )}
            {preferences.mode === 'scroll' && (
              <div className={styles.chapterNav}>
                <button
                  onClick={() => {
                    const prev = opened.book.chapters[chapterIndex - 1];
                    if (prev) void loadChapter(prev.id);
                  }}
                  disabled={chapterIndex <= 0}
                >
                  上一章
                </button>
                <button
                  onClick={() => {
                    const next = opened.book.chapters[chapterIndex + 1];
                    if (next) void loadChapter(next.id);
                  }}
                  disabled={chapterIndex >= opened.book.chapters.length - 1}
                >
                  下一章
                </button>
              </div>
            )}
          </section>
        </div>
        {message && (
          <p className={styles.readerNotice} role="alert">
            {message}
          </p>
        )}
        {!focusMode && (
          <footer className={styles.readerFooter}>
            <span>阅读位置按章节内容保存</span>
            <span>快捷键：← → 翻页 · T 目录 · F 专注 · Esc 退出专注</span>
          </footer>
        )}
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>本地阅读器</p>
          <h1>书架</h1>
          <p className={styles.muted}>
            {sorted.length ? `${sorted.length} 本书` : '导入一本书，开始阅读。'}
          </p>
        </div>
        <button
          className={styles.primary}
          onClick={() => void importBooks()}
          disabled={busy}
        >
          {busy ? '处理中…' : '导入书籍'}
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
      {shelfAnnotations && annotationView && (
        <div
          className={annotationStyles.libraryPanel}
          id="retained-annotations"
        >
          <h2>{shelfAnnotations.title}</h2>
          <button
            className={styles.bookSecondary}
            disabled={busy || annotations.busy}
            onClick={() => void replaceBook(shelfAnnotations)}
          >
            替换正文…
          </button>
          <AnnotationPanel
            key={shelfAnnotations.bookId}
            book={shelfAnnotations}
            controller={annotations}
            view={annotationView}
            setView={setAnnotationView}
            close={closeAnnotations}
          />
        </div>
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
              仅移除书文件，保留笔记和批注
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
          <div className={styles.emptyMark}>＋</div>
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
              <button
                className={styles.bookOpen}
                onClick={() => void openBook(book)}
                disabled={busy}
              >
                <BookCover book={book} />
                <div className={styles.bookInfo}>
                  <h2>{book.title}</h2>
                  <p>{book.author}</p>
                  <small>
                    {book.chapters.length
                      ? `${book.chapters.length} 个章节`
                      : '整本阅读'}
                    {book.lastReadAt ? ' · 继续阅读' : ''}
                  </small>
                </div>
              </button>
              <div className={styles.bookSecondary}>
                <button
                  onClick={() => showShelfAnnotations(book)}
                  disabled={annotations.busy}
                >
                  划线与批注
                </button>
                <button
                  className={styles.remove}
                  title={`删除${book.title}`}
                  onClick={() => setRemoving(book)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {books.some((book) => book.fileStatus === 'removed') && (
        <details className={annotationStyles.libraryRetained}>
          <summary>已移除书文件（保留的笔记和批注）</summary>
          <ul>
            {books
              .filter((book) => book.fileStatus === 'removed')
              .map((book) => (
                <li key={book.bookId} className={styles.bookSecondary}>
                  <strong>{book.title}</strong>
                  <button
                    onClick={() => showShelfAnnotations(book)}
                    disabled={annotations.busy}
                  >
                    查看保留批注
                  </button>
                  <button
                    className={styles.remove}
                    onClick={() => setRemoving(book)}
                  >
                    删除保留内容
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
    </main>
  );
}
export default App;
