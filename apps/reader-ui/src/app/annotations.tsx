import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnnotationChange,
  AnnotationSnapshot,
  BookSummary,
  HighlightColor,
  ReadingRange,
} from '@reader/storage-bridge';
import styles from './annotations.module.css';

export type AnnotationItem = AnnotationSnapshot['items'][number];
export type AnnotationView =
  | { kind: 'list' }
  | { kind: 'create'; range: ReadingRange; quote: string }
  | { kind: 'detail'; highlightId: string };

const colors: { value: HighlightColor; label: string }[] = [
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'pink', label: '粉色' },
  { value: 'blue', label: '蓝色' },
];

function readable(error: unknown) {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      )
    : '请稍后重试。';
}

export function useBookAnnotations(book: BookSummary | null) {
  const bookId = book?.bookId;
  const bookVersion =
    book && `${bookId}:${book.fileStatus}:${book.contentHash}`;
  const [snapshot, setSnapshot] = useState<AnnotationSnapshot | null>(null);
  const [status, setStatus] = useState<{
    text: string;
    failed?: boolean;
    reloadRequired?: boolean;
  }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const session = useRef<symbol>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!bookId) return;
    const active = session.current;
    setBusy(true);
    setStatus({ text: '正在读取划线…' });
    try {
      const result = await window.reader.listAnnotations({ bookId });
      if (session.current === active) {
        setSnapshot(result);
        setLoadedFor(bookVersion);
        setStatus({ text: '' });
      }
    } catch (error) {
      if (session.current === active)
        setStatus({
          text: readable(error),
          failed: true,
          reloadRequired: true,
        });
    } finally {
      if (session.current === active) setBusy(false);
    }
  }, [bookId, bookVersion]);

  useEffect(() => {
    session.current = Symbol();
    setSnapshot(null);
    setLoadedFor(null);
    setStatus({ text: '' });
    setBusy(false);
    void reload();
    return () => {
      session.current = null;
    };
  }, [reload]);

  const current = loadedFor === bookVersion ? snapshot : null;
  const canChange = Boolean(current && !busy && !status.reloadRequired);
  const change = async (operation: AnnotationChange) => {
    if (!bookId || !current || !canChange) return null;
    const active = session.current;
    setBusy(true);
    setStatus({ text: '正在保存批注…' });
    try {
      const result = await window.reader.changeAnnotation({
        bookId,
        expectedRevision: current.revision,
        change: operation,
      });
      if (session.current !== active) return null;
      setSnapshot(result);
      setStatus({
        text:
          operation.kind === 'remove'
            ? '已删除划线，可撤销。'
            : operation.kind === 'undo'
              ? '已恢复划线。'
              : '划线与批注已保存。',
      });
      return result;
    } catch (error) {
      if (session.current === active)
        setStatus({
          text: readable(error),
          failed: true,
          reloadRequired: true,
        });
      return null;
    } finally {
      if (session.current === active) setBusy(false);
    }
  };
  const copy = async (highlightId: string) => {
    if (!bookId || !canChange) return;
    const active = session.current;
    try {
      await window.reader.copyAnnotation({ bookId, highlightId });
      if (session.current === active)
        setStatus({ text: '已复制原文、出处及批注。' });
    } catch (error) {
      if (session.current === active)
        setStatus({ text: readable(error), failed: true });
    }
  };
  return { snapshot: current, status, busy, canChange, change, copy, reload };
}

type Controller = ReturnType<typeof useBookAnnotations>;

function AnnotationEditor({
  item,
  quote,
  disabled,
  onSave,
}: {
  item?: AnnotationItem;
  quote: string;
  disabled: boolean;
  onSave: (color: HighlightColor, text: string) => void;
}) {
  const [color, setColor] = useState(item?.color || 'yellow');
  const [text, setText] = useState(item?.annotation?.text || '');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!item) input.current?.focus({ preventScroll: true });
  }, [item]);
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(color, text);
      }}
    >
      <blockquote className={styles.quote}>
        {quote.replace(/￼/g, '[图片]')}
      </blockquote>
      {item && (
        <small>
          {item.anchor.source.title} · {item.anchor.source.author} ·{' '}
          {item.anchor.source.chapterTitle}
        </small>
      )}
      <label>
        划线颜色{' '}
        <select
          value={color}
          onChange={(event) => setColor(event.target.value as HighlightColor)}
          disabled={disabled}
        >
          {colors.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        我的批注{' '}
        <textarea
          name="annotation"
          rows={3}
          maxLength={8000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={disabled}
          placeholder="这一段让你想到什么？"
          ref={input}
        />
      </label>
      <button type="submit" disabled={disabled}>
        保存批注
      </button>
    </form>
  );
}

export function AnnotationPanel({
  book,
  controller,
  view,
  setView,
  close,
  jump,
}: {
  book: BookSummary;
  controller: Controller;
  view: AnnotationView;
  setView: (view: AnnotationView) => void;
  close: () => void;
  jump?: (item: AnnotationItem) => void;
}) {
  const [sort, setSort] = useState<'chapter' | 'time'>('chapter');
  const heading = useRef<HTMLHeadingElement>(null);
  const { snapshot, busy, status, canChange, change, copy, reload } =
    controller;
  const item =
    view.kind === 'detail'
      ? snapshot?.items.find((entry) => entry.highlightId === view.highlightId)
      : undefined;
  const disabled = !canChange;
  const entries = useMemo(() => {
    const order = new Map(book.chapters.map(({ id }, index) => [id, index]));
    const latest = (a: AnnotationItem, b: AnnotationItem) =>
      b.anchor.createdAt.localeCompare(a.anchor.createdAt);
    const position = (entry: AnnotationItem) =>
      entry.resolution.status === 'lost'
        ? entry.anchor.range.start
        : entry.resolution.range.start;
    return [...(snapshot?.items || [])].sort((a, b) => {
      if (sort === 'time') return latest(a, b);
      const x = position(a);
      const y = position(b);
      return (
        (order.get(x.chapterId) ?? Infinity) -
          (order.get(y.chapterId) ?? Infinity) ||
        x.blockIndex - y.blockIndex ||
        x.offset - y.offset ||
        latest(a, b)
      );
    });
  }, [book.chapters, snapshot, sort]);
  useEffect(() => {
    if (view.kind !== 'create') heading.current?.focus({ preventScroll: true });
  }, [view]);

  function submit(color: HighlightColor, text: string) {
    if (view.kind === 'create') {
      void change({
        kind: 'create',
        range: view.range,
        contentHash: book.contentHash,
        color,
        text,
      }).then((result) => {
        const last = result?.items[result.items.length - 1];
        if (last) setView({ kind: 'detail', highlightId: last.highlightId });
      });
    } else if (item)
      void change({
        kind: 'update',
        highlightId: item.highlightId,
        color,
        text,
      });
  }
  function remove(highlightId: string) {
    void change({ kind: 'remove', highlightId }).then((result) => {
      if (result) setView({ kind: 'list' });
    });
  }

  return (
    <section className={styles.panel} aria-label="本书划线与批注">
      <div className={styles.panelHeading}>
        <h2 tabIndex={-1} ref={heading}>
          {view.kind === 'create'
            ? '新建批注'
            : item
              ? '划线与批注'
              : '全书划线'}
        </h2>
        <button type="button" onClick={close} disabled={busy}>
          关闭
        </button>
      </div>
      {status.text && (
        <p role={status.failed ? 'alert' : 'status'}>{status.text}</p>
      )}
      {status.reloadRequired && (
        <button type="button" disabled={busy} onClick={() => void reload()}>
          重新载入划线
        </button>
      )}
      {snapshot?.undoHighlightId && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const highlightId = snapshot.undoHighlightId;
            if (highlightId)
              void change({ kind: 'undo', highlightId }).then((result) => {
                if (result) setView({ kind: 'detail', highlightId });
              });
          }}
        >
          撤销删除
        </button>
      )}
      {view.kind === 'create' ? (
        <AnnotationEditor
          key="new"
          quote={view.quote}
          disabled={disabled}
          onSave={submit}
        />
      ) : item ? (
        <>
          {item.resolution.status === 'lost' && (
            <p className={styles.lost}>
              位置丢失 ·{' '}
              {item.resolution.reason === 'ambiguous'
                ? '原文有多处可能位置'
                : item.resolution.reason === 'book-unavailable'
                  ? '原书不可用'
                  : '未找到原文'}
            </p>
          )}
          {item.resolution.status === 'fallback' && <p>已按原文片段重新定位</p>}
          {jump && item.resolution.status !== 'lost' && (
            <button type="button" onClick={() => jump(item)}>
              定位原文
            </button>
          )}
          <AnnotationEditor
            key={item.highlightId}
            item={item}
            quote={item.anchor.exact}
            disabled={disabled}
            onSave={submit}
          />
          <div className={styles.panelActions}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void copy(item.highlightId)}
            >
              复制原文与批注
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(item.highlightId)}
            >
              删除划线
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setView({ kind: 'list' })}
            >
              返回列表
            </button>
          </div>
        </>
      ) : (
        <>
          <label>
            排序{' '}
            <select
              value={sort}
              onChange={(event) =>
                setSort(event.target.value === 'time' ? 'time' : 'chapter')
              }
            >
              <option value="chapter">章节顺序</option>
              <option value="time">最新优先</option>
            </select>
          </label>
          {snapshot && !entries.length && (
            <p>还没有划线。选中正文即可划线或写批注。</p>
          )}
          <ul className={styles.entries}>
            {entries.map((entry) => (
              <li key={entry.highlightId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setView({ kind: 'detail', highlightId: entry.highlightId });
                    if (entry.resolution.status !== 'lost') jump?.(entry);
                  }}
                >
                  <span data-highlight-color={entry.color}>
                    {entry.anchor.exact.replace(/￼/g, '[图片]')}
                  </span>
                  <small>
                    {entry.anchor.source.chapterTitle}
                    {entry.resolution.status === 'lost' ? ' · 位置丢失' : ''}
                    {entry.annotation?.text ? ' · 有批注' : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
