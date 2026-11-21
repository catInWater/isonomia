import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import type {
  BookSummary,
  ImportFailure,
  HighlightColor,
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
import { ReaderPopover } from './reader-overlays';
import { referenceText } from './reference-text';
import type { OverlayAnchor } from './reader-overlays';
import { ReaderToolbar } from './reader-toolbar';
import type { AnnotationView } from './annotations';
import { NotePanel } from './notes';
import type { NotePanelHandle } from './notes';
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
  fontFamily: 'serif',
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
  onNavigate?: (target: ReadingPosition, anchor: OverlayAnchor) => void,
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
              highlightId
                ? '点击打开批注；Alt + 点击查看引用内容'
                : '查看引用内容'
            }
            onClick={(event) => {
              event.preventDefault();
              if (window.getSelection()?.isCollapsed === false) return;
              if (highlightId && !event.altKey) openHighlight();
              else {
                const rect = event.currentTarget.getBoundingClientRect();
                onNavigate(target, {
                  left: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                });
              }
            }}
            onKeyDown={(event) => {
              if (highlightId && event.altKey && event.key === 'Enter') {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                onNavigate(target, {
                  left: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                });
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
  const [shelfNotes, setShelfNotes] = useState<BookSummary | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<OverlayAnchor | null>(
    null,
  );
  const [annotationAnchor, setAnnotationAnchor] =
    useState<OverlayAnchor | null>(null);
  const [reference, setReference] = useState<{
    anchor: OverlayAnchor;
    text: string;
    loading: boolean;
  } | null>(null);
  const referenceRequest = useRef(0);
  const closeReference = useCallback(() => {
    referenceRequest.current++;
    setReference(null);
  }, []);
  const [draggingSource, setDraggingSource] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [notesLayout, setNotesLayout] = useState({
    width: 0,
    ratio: 0.5,
    collapsed: false,
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [noteActionBusy, setNoteActionBusy] = useState(false);
  const notePanel = useRef<NotePanelHandle>(null);
  const shelfNotePanel = useRef<NotePanelHandle>(null);
  const notesContainer = useRef<HTMLElement>(null);
  const shelfNotesContainer = useRef<HTMLElement>(null);
  const notesToggle = useRef<HTMLButtonElement>(null);
  const shelfNotesReturnFocus = useRef<HTMLElement | null>(null);
  const noteOperations = useRef<Promise<void>>(Promise.resolve());
  const settingsWrites = useRef<Promise<void>>(Promise.resolve());
  const layoutTouched = useRef(false);
  const changingBook = useRef(false);
  const activeBook = useRef(opened?.book);
  activeBook.current = opened?.book;
  const draggedSelection = useRef<{
    token: string;
    bookId: string;
    contentHash: string;
    range: ReadingRange;
  } | null>(null);
  const dragToken = useRef<string | null>(null);
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
  const notesResize = useRef<{ x: number; width: number; next: number } | null>(
    null,
  );

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
      const selected = readSelection(area, chapter);
      setSelection(selected);
      const native = window.getSelection();
      const rects =
        selected && native?.rangeCount
          ? native.getRangeAt(0).getClientRects()
          : null;
      const rect = rects?.[0];
      setSelectionAnchor(
        rect ? { left: rect.right, top: rect.top, bottom: rect.bottom } : null,
      );
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
    let active = true;
    void window.reader
      .load('settings')
      .then((record) => {
        if (!active || layoutTouched.current) return;
        const data = record?.data;
        const layout =
          data && typeof data === 'object' && !Array.isArray(data)
            ? data.notesLayout
            : null;
        if (!layout || typeof layout !== 'object' || Array.isArray(layout))
          return;
        if (layoutPosition.current) setPosition({ ...layoutPosition.current });
        restorePending.current = true;
        setNotesLayout({
          width: 0,
          ratio:
            typeof layout.ratio === 'number' && Number.isFinite(layout.ratio)
              ? Math.max(0.25, Math.min(0.75, layout.ratio))
              : 0.5,
          collapsed: layout.collapsed === true,
        });
      })
      .catch(() => {
        if (active) setMessage('笔记布局未能恢复；现有笔记不受影响。');
      });
    return () => {
      active = false;
    };
  }, []);

  const persistNotesLayout = (layout: typeof notesLayout) => {
    layoutTouched.current = true;
    settingsWrites.current = settingsWrites.current
      .then(async () => {
        // Reload and merge for every write: reading and other settings share this record.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const record = await window.reader.load('settings');
            const data = record?.data;
            await window.reader.save(
              'settings',
              {
                ...(data && typeof data === 'object' && !Array.isArray(data)
                  ? data
                  : {}),
                notesLayout: layout,
              },
              record?.revision ?? 0,
            );
            return;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
      })
      .catch(() => setMessage('笔记布局未保存，请重新调整后重试。'));
  };

  const flushNotes = async () => {
    await noteOperations.current;
    try {
      if (notePanel.current && !(await notePanel.current.flush())) return false;
      if (shelfNotePanel.current && !(await shelfNotePanel.current.flush()))
        return false;
      return true;
    } catch {
      setMessage('笔记尚未保存，请重试或导出后再离开。');
      return false;
    }
  };

  const closeShelfNotes = async () => {
    if (changingBook.current) return;
    changingBook.current = true;
    try {
      if (!(await flushNotes())) return;
      setShelfNotes(null);
      requestAnimationFrame(() => shelfNotesReturnFocus.current?.focus());
    } finally {
      changingBook.current = false;
    }
  };

  const showShelfNotes = async (book: BookSummary) => {
    if (changingBook.current) return;
    changingBook.current = true;
    try {
      if (!(await flushNotes())) return;
      shelfNotesReturnFocus.current = document.activeElement as HTMLElement;
      setShelfNotes(book);
    } finally {
      changingBook.current = false;
    }
  };

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

  const narrowNotes = viewport.width < 700;
  const splitWidth = Math.max(
    1,
    viewport.width - (tocOpen && !focusMode ? 220 : 0) - 10,
  );
  const maxNotesWidth = Math.max(220, splitWidth * 0.75);
  const visibleNotesWidth = Math.round(
    Math.max(
      Math.min(220, splitWidth / 2),
      Math.min(splitWidth * notesLayout.ratio, maxNotesWidth),
    ),
  );
  const notesVisible =
    !focusMode && (narrowNotes ? drawerOpen : !notesLayout.collapsed);
  const layoutPosition = useRef<ReadingPosition | null>(null);
  useEffect(() => {
    layoutPosition.current = position;
  }, [position]);
  const preserveReaderPosition = useCallback(() => {
    const current =
      preferences.mode === 'scroll'
        ? captureScrollPosition() || position
        : position;
    if (current) {
      layoutPosition.current = current;
      setPosition(current);
    }
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = null;
    restorePending.current = true;
  }, [captureScrollPosition, position, preferences.mode]);
  useEffect(() => {
    const onResize = () => {
      if (layoutPosition.current) setPosition({ ...layoutPosition.current });
      restorePending.current = true;
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleNotes = () => {
    preserveReaderPosition();
    if (narrowNotes) setDrawerOpen((value) => !value);
    else {
      const next = { ...notesLayout, collapsed: !notesLayout.collapsed };
      setNotesLayout(next);
      persistNotesLayout(next);
    }
  };
  const revealNotes = () => {
    if (!notesVisible) {
      preserveReaderPosition();
      setFocusMode(false);
      if (narrowNotes) setDrawerOpen(true);
      else {
        const next = { ...notesLayout, collapsed: false };
        setNotesLayout(next);
        persistNotesLayout(next);
      }
    }
  };

  useEffect(() => {
    const modal = shelfNotes
      ? shelfNotesContainer.current
      : opened && narrowNotes && notesVisible
        ? notesContainer.current
        : null;
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() =>
      modal
        .querySelector<HTMLElement>('button, [contenteditable="true"]')
        ?.focus(),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (shelfNotes) void closeShelfNotes();
        else {
          setDrawerOpen(false);
          notesToggle.current?.focus();
        }
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          modal.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"], [contenteditable="true"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (
          first &&
          (!modal.contains(document.activeElement) ||
            (event.shiftKey
              ? document.activeElement === first
              : document.activeElement === last))
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // Closing is guarded by the latest mounted panel ref, not the render's book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelfNotes?.bookId, opened?.book.bookId, narrowNotes, notesVisible]);

  const closeReader = async () => {
    if (changingBook.current) return;
    changingBook.current = true;
    try {
      if (!(await flushNotes())) return;
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
      closeReference();
      setOpened(null);
      setChapter(null);
      setDrawerOpen(false);
      draggedSelection.current = null;
      dragToken.current = null;
      void refresh();
    } finally {
      changingBook.current = false;
    }
  };

  const openBook = async (book: BookSummary) => {
    if (changingBook.current) return;
    changingBook.current = true;
    try {
      if (!(await flushNotes())) return;
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
        setShelfNotes(null);
        setDrawerOpen(false);
        draggedSelection.current = null;
        dragToken.current = null;
        closeReference();
        setTocOpen(false);
        setToolbarOpen(false);
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
    } finally {
      changingBook.current = false;
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
        closeReference();
        setAnnotationView(null);
        setAnnotationAnchor(null);
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
    [opened, position, persistReading, clearSelection, closeReference],
  );

  const followBookLink = async (
    target: ReadingPosition,
    anchor: OverlayAnchor,
  ) => {
    if (!opened) return;
    const request = ++referenceRequest.current;
    const bookId = opened.book.bookId;
    setReference({ anchor, text: '', loading: true });
    try {
      const source =
        target.chapterId === chapter?.id
          ? chapter
          : await window.reader.readChapter({
              bookId,
              chapterId: target.chapterId,
            });
      if (
        referenceRequest.current !== request ||
        activeBook.current?.bookId !== bookId
      )
        return;
      setReference({
        anchor,
        text: referenceText(source, target) || '此引用没有可显示的文字。',
        loading: false,
      });
    } catch {
      if (referenceRequest.current === request)
        setReference({
          anchor,
          text: '引用暂时无法读取，请重试。',
          loading: false,
        });
    }
  };

  const pages = useMemo(
    () =>
      chapter
        ? makePages(
            chapter,
            estimatePageCapacity(preferences.fontSize, preferences.lineHeight, {
              ...viewport,
              width:
                viewport.width -
                (focusMode
                  ? 0
                  : (tocOpen ? 220 : 0) +
                    (notesVisible && !narrowNotes
                      ? visibleNotesWidth + 12
                      : 0)),
            }),
          )
        : [],
    [
      chapter,
      preferences.fontSize,
      preferences.lineHeight,
      viewport,
      focusMode,
      narrowNotes,
      visibleNotesWidth,
      tocOpen,
      notesVisible,
    ],
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
    if (focusMode) preserveReaderPosition();
    setFocusMode(false);
    const element = readingArea.current?.querySelector<HTMLElement>(
      `[data-highlight-id="${highlightId}"]`,
    );
    const rect = element?.getBoundingClientRect();
    if (rect)
      setAnnotationAnchor({
        left: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    setAnnotationView({ kind: 'detail', highlightId });
  };
  const jumpToRange = async (range: ReadingRange) => {
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    linkFocusPending.current = true;
    setJumpRange(range);
    if (!(await loadChapter(range.start.chapterId, range.start))) {
      setJumpRange(null);
      return;
    }
    jumpTimer.current = setTimeout(() => setJumpRange(null), 1800);
    if (narrowNotes) setDrawerOpen(false);
  };

  const queueNoteOperation = (operation: () => Promise<void>) => {
    if (changingBook.current) return Promise.resolve();
    setNoteActionBusy(true);
    const pending = noteOperations.current
      .then(operation)
      .catch((error: unknown) => {
        setMessage(
          error instanceof Error ? error.message : '无法插入笔记，请重试。',
        );
      });
    noteOperations.current = pending;
    void pending.finally(() => {
      if (noteOperations.current === pending) setNoteActionBusy(false);
    });
    return pending;
  };
  const insertNoteSelection = (range: ReadingRange) => {
    const book = opened?.book;
    const panel = notePanel.current;
    if (!book || !panel) return Promise.resolve();
    revealNotes();
    return queueNoteOperation(async () => {
      if (
        activeBook.current?.bookId !== book.bookId ||
        activeBook.current.contentHash !== book.contentHash ||
        notePanel.current !== panel
      )
        return;
      const anchor = await window.reader.createNoteSource({
        bookId: book.bookId,
        contentHash: book.contentHash,
        range,
      });
      if (
        activeBook.current?.bookId !== book.bookId ||
        activeBook.current.contentHash !== book.contentHash ||
        notePanel.current !== panel
      )
        return;
      panel.insertSources([{ anchor }], false);
    });
  };
  const startSourceDrag = (event: DragEvent<HTMLElement>) => {
    draggedSelection.current = null;
    dragToken.current = null;
    const native =
      chapter && readingArea.current
        ? readSelection(readingArea.current, chapter)
        : null;
    const range =
      native &&
      (!crossStart || comparePositions(crossStart.end, native.start) <= 0)
        ? { start: crossStart?.start ?? native.start, end: native.end }
        : null;
    if (
      !opened ||
      !range ||
      changingBook.current ||
      range.start.chapterId !== chapter?.id ||
      range.end.chapterId !== chapter.id
    ) {
      event.preventDefault();
      return;
    }
    const token = crypto.randomUUID();
    dragToken.current = token;
    draggedSelection.current = {
      token,
      bookId: opened.book.bookId,
      contentHash: opened.book.contentHash,
      range,
    };
    event.dataTransfer.clearData();
    event.dataTransfer.setData('application/x-reader-selection', token);
    event.dataTransfer.effectAllowed = 'copy';
    setDraggingSource(true);
  };
  const dropNoteSource = async (token: string) => {
    const captured = draggedSelection.current;
    if (
      !captured ||
      !dragToken.current ||
      token !== dragToken.current ||
      captured.token !== dragToken.current ||
      captured.bookId !== activeBook.current?.bookId ||
      captured.contentHash !== activeBook.current.contentHash
    )
      return;
    // Consume only our own live drag; never deserialize a dragged range or anchor.
    draggedSelection.current = null;
    dragToken.current = null;
    setDraggingSource(false);
    setDropActive(false);
    await insertNoteSelection(captured.range);
  };
  const importNoteAnnotations = (single = false) => {
    const book = opened?.book;
    const panel = notePanel.current;
    if (!book || !panel || !annotations.snapshot) return;
    const highlightId =
      annotationView?.kind === 'detail' ? annotationView.highlightId : null;
    const chapterOrder = new Map(
      book.chapters.map((item, index) => [item.id, index]),
    );
    const items = annotations.snapshot.items
      .filter(
        (item) =>
          item.annotation && (!single || item.highlightId === highlightId),
      )
      .sort(
        (a, b) =>
          (chapterOrder.get(a.anchor.range.start.chapterId) ??
            Number.MAX_SAFE_INTEGER) -
            (chapterOrder.get(b.anchor.range.start.chapterId) ??
              Number.MAX_SAFE_INTEGER) ||
          comparePositions(a.anchor.range.start, b.anchor.range.start) ||
          comparePositions(a.anchor.range.end, b.anchor.range.end) ||
          (a.annotation?.annotationId ?? '').localeCompare(
            b.annotation?.annotationId ?? '',
          ),
      );
    if (!items.length) return;
    revealNotes();
    void queueNoteOperation(async () => {
      if (
        activeBook.current?.bookId !== book.bookId ||
        activeBook.current.contentHash !== book.contentHash ||
        notePanel.current !== panel
      )
        return;
      panel.insertSources(
        items.flatMap((item) =>
          item.annotation
            ? [
                {
                  anchor: item.anchor,
                  annotationId: item.annotation.annotationId,
                  text: item.annotation.text,
                },
              ]
            : [],
        ),
        true,
      );
    });
  };

  const closeAnnotations = (restoreFocus = true) => {
    setAnnotationView(null);
    setShelfAnnotations(null);
    if (restoreFocus && opened)
      requestAnimationFrame(() =>
        readingArea.current?.focus({ preventScroll: true }),
      );
  };

  const writeAnnotation = () => {
    if (!chapter || !selectedRange) return;
    setAnnotationAnchor(selectionAnchor);
    setAnnotationView({
      kind: 'create',
      range: selectedRange,
      quote: selectionPreview(chapter, selectedRange),
    });
    clearSelection();
    setCrossStart(null);
  };
  const quickHighlight = async (color: HighlightColor) => {
    if (!selectedRange || !opened) return;
    const result = await annotations.change({
      kind: 'create',
      color,
      text: '',
      range: selectedRange,
      contentHash: opened.book.contentHash,
    });
    if (result) {
      clearSelection();
      setCrossStart(null);
      setAnnotationAnchor(null);
    } else {
      setAnnotationAnchor(selectionAnchor);
      setAnnotationView((current) => current ?? { kind: 'list' });
    }
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
    viewport,
    notesLayout,
    focusMode,
  ]);

  useEffect(() => {
    if (!opened || !chapter || preferences.mode !== 'scroll') return;
    const area = readingArea.current;
    if (!area) return;
    const onScroll = () => {
      if (restorePending.current) return;
      layoutPosition.current = captureScrollPosition();
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
        preserveReaderPosition();
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
        preserveReaderPosition();
        setTocOpen((value) => !value);
        requestAnimationFrame(() =>
          document.getElementById('reader-toc')?.focus(),
        );
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        preserveReaderPosition();
        setFocusMode((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    opened,
    chapter,
    pageIndex,
    pageCount,
    focusMode,
    pages,
    stepPage,
    preserveReaderPosition,
  ]);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );

  const toggleFocus = () => {
    preserveReaderPosition();
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
        '"Times New Roman", SimSun, "Songti SC", "Noto Serif CJK SC", serif',
    };
    const chapterIndex = opened.book.chapters.findIndex(
      (item) => item.id === chapter.id,
    );
    return (
      <main
        className={`${styles.readerShell} ${themeClass} ${focusMode ? styles.focusMode : ''} ${narrowNotes ? styles.narrowReader : ''}`}
      >
        <div
          className={styles.topEdge}
          onMouseEnter={() => setToolbarOpen(true)}
          onMouseLeave={() => setToolbarOpen(false)}
        />
        <button
          className={styles.leftEdge}
          aria-label="显示目录"
          title="目录 (T)"
          onMouseEnter={() => {
            preserveReaderPosition();
            setTocOpen(true);
          }}
          onClick={() => {
            preserveReaderPosition();
            setTocOpen(true);
          }}
        >
          ☰
        </button>
        {!focusMode && (
          <header
            className={styles.readerHeader}
            data-open={toolbarOpen}
            onMouseEnter={() => setToolbarOpen(true)}
            onMouseLeave={() => setToolbarOpen(false)}
          >
            <button
              className={styles.backButton}
              aria-label="返回书架"
              title="返回书架"
              onClick={() => void closeReader()}
            >
              <span aria-hidden="true">←</span>
            </button>
            <div className={styles.readerBookTitle}>
              <strong>{opened.book.title}</strong>
              <span>{chapter.title}</span>
            </div>
            <ReaderToolbar
              preferences={preferences}
              update={updatePreferences}
              notesVisible={notesVisible}
              toggleNotes={toggleNotes}
              notesToggle={notesToggle}
              toggleFocus={toggleFocus}
            />
            <div className={styles.saveState} role="status">
              {saving ? '保存中…' : saveFailed ? '保存失败' : '进度已保存'}
            </div>
          </header>
        )}
        <div
          className={`${styles.readerLayout} ${!notesVisible || narrowNotes ? styles.notesCollapsed : ''} ${tocOpen && !focusMode ? styles.tocExpanded : ''}`}
          style={
            {
              ...typographyStyle,
              '--notes-width': `${visibleNotesWidth}px`,
              '--toc-width': tocOpen && !focusMode ? '220px' : '0px',
            } as ReaderStyle
          }
        >
          {!focusMode && (
            <aside
              className={styles.toc}
              aria-label="目录"
              data-open={tocOpen}
              inert={!tocOpen}
              onMouseLeave={() => {
                preserveReaderPosition();
                setTocOpen(false);
              }}
            >
              <div className={styles.tocHeading}>
                <span>目录</span>
                <button
                  aria-label="隐藏目录"
                  onClick={() => {
                    preserveReaderPosition();
                    setTocOpen(false);
                  }}
                >
                  ×
                </button>
              </div>
              <nav id="reader-toc" tabIndex={-1}>
                {opened.book.chapters.map((item, index) => (
                  <button
                    key={item.id}
                    className={
                      item.id === chapter.id ? styles.activeChapter : ''
                    }
                    onClick={() => {
                      void loadChapter(item.id);
                      setTocOpen(false);
                    }}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    {item.title}
                  </button>
                ))}
              </nav>
            </aside>
          )}
          {notesVisible && !narrowNotes && (
            <div
              className={styles.notesSeparator}
              role="separator"
              tabIndex={0}
              aria-label="调整笔记宽度（左右方向键调整，Enter 收起）"
              aria-orientation="vertical"
              aria-valuemin={260}
              aria-valuemax={maxNotesWidth}
              aria-valuenow={visibleNotesWidth}
              aria-controls="reader-notes"
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Enter') {
                  toggleNotes();
                  notesToggle.current?.focus();
                  return;
                }
                preserveReaderPosition();
                const width =
                  event.key === 'Home'
                    ? 260
                    : event.key === 'End'
                      ? maxNotesWidth
                      : Math.max(
                          260,
                          Math.min(
                            maxNotesWidth,
                            visibleNotesWidth +
                              (event.key === 'ArrowLeft' ? 20 : -20),
                          ),
                        );
                const next = {
                  ...notesLayout,
                  width,
                  ratio: width / splitWidth,
                };
                setNotesLayout(next);
                persistNotesLayout(next);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                preserveReaderPosition();
                notesResize.current = {
                  x: event.clientX,
                  width: visibleNotesWidth,
                  next: visibleNotesWidth,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const resize = notesResize.current;
                if (!resize) return;
                resize.next = Math.max(
                  260,
                  Math.min(
                    maxNotesWidth,
                    resize.width + resize.x - event.clientX,
                  ),
                );
                restorePending.current = true;
                setNotesLayout((current) => ({
                  ...current,
                  width: resize.next,
                  ratio: resize.next / splitWidth,
                }));
              }}
              onPointerUp={(event) => {
                const resize = notesResize.current;
                if (!resize) return;
                notesResize.current = null;
                persistNotesLayout({
                  ...notesLayout,
                  width: resize.next,
                  ratio: resize.next / splitWidth,
                });
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => {
                const resize = notesResize.current;
                if (resize) {
                  persistNotesLayout({
                    ...notesLayout,
                    width: resize.next,
                    ratio: resize.next / splitWidth,
                  });
                  notesResize.current = null;
                }
              }}
            />
          )}
          {narrowNotes && notesVisible && (
            <div
              className={styles.notesScrim}
              aria-hidden="true"
              onClick={() => {
                setDrawerOpen(false);
                notesToggle.current?.focus();
              }}
            />
          )}
          <aside
            id="reader-notes"
            ref={notesContainer}
            className={`${styles.notesDock} ${narrowNotes ? styles.notesDrawer : ''}`}
            hidden={!notesVisible}
            role={narrowNotes ? 'dialog' : undefined}
            aria-modal={narrowNotes && notesVisible ? true : undefined}
            aria-label="本书笔记"
          >
            <button
              className={styles.readerNotesClose}
              onClick={() => {
                toggleNotes();
                notesToggle.current?.focus();
              }}
              aria-label={narrowNotes ? '关闭笔记抽屉' : '收起笔记'}
            >
              ×
            </button>
            <NotePanel
              ref={notePanel}
              key={opened.book.bookId}
              bookId={opened.book.bookId}
              hidden={!notesVisible}
              onJump={(range) => {
                void jumpToRange(range);
              }}
              onDropSource={dropNoteSource}
            />
          </aside>
          <section className={styles.readingColumn}>
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
                tabIndex={-1}
                onDragStart={startSourceDrag}
                onDragEnd={() => {
                  draggedSelection.current = null;
                  dragToken.current = null;
                  setDraggingSource(false);
                  setDropActive(false);
                }}
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
                  tabIndex={-1}
                  onDragStart={startSourceDrag}
                  onDragEnd={() => {
                    draggedSelection.current = null;
                    dragToken.current = null;
                    setDraggingSource(false);
                    setDropActive(false);
                  }}
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
        {selectedRange && selectionAnchor && !draggingSource && (
          <div
            className={styles.selectionPalette}
            role="toolbar"
            aria-label="选区操作"
            style={{
              left: Math.max(
                16,
                Math.min(selectionAnchor.left + 8, viewport.width - 240),
              ),
              top: Math.max(12, selectionAnchor.top - 46),
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {(['yellow', 'green', 'pink', 'blue'] as HighlightColor[]).map(
              (color, index) => (
                <button
                  key={color}
                  data-highlight-color={color}
                  aria-label={`${['黄色', '绿色', '粉色', '蓝色'][index]}划线`}
                  title={`${['黄色', '绿色', '粉色', '蓝色'][index]}划线`}
                  disabled={!annotations.canChange || busy}
                  onClick={() => void quickHighlight(color)}
                >
                  ●
                </button>
              ),
            )}
            <button
              aria-label="写批注"
              title="写批注"
              disabled={!annotations.canChange || busy}
              onClick={writeAnnotation}
            >
              ✎
            </button>
            <button
              aria-label="插入选区到笔记"
              title="插入选区到笔记"
              disabled={busy || noteActionBusy}
              onClick={() => void insertNoteSelection(selectedRange)}
            >
              ↗
            </button>
            {!crossStart &&
              preferences.mode === 'paginated' &&
              pageIndex + 1 < pageCount && (
                <button
                  aria-label="跨页选取"
                  title="跨页选取"
                  onClick={() => {
                    setCrossStart(selectedRange);
                    stepPage(1);
                  }}
                >
                  ⇥
                </button>
              )}
          </div>
        )}
        {crossStart && (
          <button
            className={styles.crossSelection}
            onClick={() => {
              setCrossStart(null);
              clearSelection();
            }}
          >
            × 取消跨页选取
          </button>
        )}
        {reference && (
          <ReaderPopover
            anchor={reference.anchor}
            label="引用内容"
            close={closeReference}
          >
            <p aria-live="polite">
              {reference.loading ? '正在读取…' : reference.text}
            </p>
          </ReaderPopover>
        )}
        {annotationView && annotationAnchor && (
          <ReaderPopover
            anchor={annotationAnchor}
            label="划线批注"
            close={closeAnnotations}
            dismissOutside={() => closeAnnotations(false)}
          >
            <AnnotationPanel
              book={opened.book}
              controller={annotations}
              view={annotationView}
              setView={setAnnotationView}
              close={closeAnnotations}
            />
            <div className={styles.annotationImportActions}>
              <button
                aria-label="此条批注汇入笔记"
                title="此条批注汇入笔记"
                disabled={
                  annotationView.kind !== 'detail' ||
                  noteActionBusy ||
                  annotations.busy
                }
                onClick={() => importNoteAnnotations(true)}
              >
                ↗
              </button>
              <button
                aria-label="全部批注汇入笔记"
                title="全部批注汇入笔记"
                disabled={noteActionBusy || annotations.busy}
                onClick={() => importNoteAnnotations(false)}
              >
                ⇉
              </button>
            </div>
          </ReaderPopover>
        )}
        {draggingSource && !notesVisible && (
          <div
            className={styles.sourceDropZone}
            data-active={dropActive}
            role="region"
            aria-label="拖到此处打开笔记"
            onDragOver={(event) => {
              if (dragToken.current) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDropActive(true);
              }
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              void dropNoteSource(
                event.dataTransfer.getData('application/x-reader-selection'),
              );
            }}
          >
            ↗ note
          </div>
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
      {shelfNotes && (
        <div className={styles.backdrop} role="presentation">
          <section
            ref={shelfNotesContainer}
            className={styles.retainedNotesDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="retained-notes-title"
          >
            <div className={styles.notesDockHeader}>
              <h2 id="retained-notes-title">{shelfNotes.title} · 笔记</h2>
              <button onClick={() => void closeShelfNotes()}>保存并关闭</button>
            </div>
            {shelfNotes.fileStatus === 'removed' && (
              <p>书文件已移除；仍可编辑与导出笔记，引用保留原文快照。</p>
            )}
            <NotePanel
              key={shelfNotes.bookId}
              ref={shelfNotePanel}
              bookId={shelfNotes.bookId}
            />
          </section>
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
                  onClick={() => void showShelfNotes(book)}
                  disabled={busy}
                >
                  笔记
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
                    onClick={() => void showShelfNotes(book)}
                    disabled={busy}
                  >
                    查看保留笔记
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
