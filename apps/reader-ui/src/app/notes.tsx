import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type {
  AnchorResolution,
  NoteDocument,
  ReadingRange,
  SourceAnchor,
} from '@reader/storage-bridge';
import styles from './notes.module.css';
import {
  escapeNoteText,
  parseNoteDocument,
  serializeNoteDocument,
  sourceMarkup,
} from './note-document';
import { NoteSaveSession } from './note-save';

export interface NoteInsertion {
  anchor: SourceAnchor;
  annotationId?: string;
  text?: string;
}
export interface NotePanelHandle {
  insertSources(sources: NoteInsertion[], atEnd?: boolean): void;
  flush(): Promise<boolean>;
}
interface Props {
  bookId: string;
  hidden?: boolean;
  onJump?: (range: ReadingRange) => void;
  onDropSource?: (token: string) => Promise<void>;
}
interface HistoryEntry {
  document: NoteDocument;
  html: string;
}

export const NotePanel = forwardRef<NotePanelHandle, Props>(function NotePanel(
  { bookId, hidden, onJump, onDropSource },
  ref,
) {
  const editor = useRef<HTMLDivElement>(null);
  const session = useRef<NoteSaveSession | null>(null);
  const model = useRef<NoteDocument>({
    schemaVersion: 1,
    html: '',
    sources: [],
    importedAnnotationIds: [],
  });
  const caret = useRef<Range | null>(null);
  const history = useRef<HistoryEntry[]>([]);
  const historyIndex = useRef(0);
  const composing = useRef(false);
  const [, render] = useState(0);
  const [notice, setNotice] = useState('');
  const [resolutions, setResolutions] = useState<
    Record<string, AnchorResolution>
  >({});
  const notify = () => render((value) => value + 1);

  useEffect(() => {
    let active = true;
    const current = new NoteSaveSession(bookId, window.reader, () => {
      if (active) notify();
    });
    session.current = current;
    caret.current = null;
    setNotice('');
    setResolutions({});
    if (editor.current) editor.current.innerHTML = '';
    void current.load().then((loaded) => {
      if (!active || !loaded || !editor.current) return;
      try {
        model.current = parseNoteDocument(current.document);
        editor.current.innerHTML = model.current.html;
        history.current = [
          {
            document: structuredClone(model.current),
            html: editor.current.innerHTML,
          },
        ];
        historyIndex.current = 0;
        setResolutions(current.snapshot!.resolutions);
      } catch (error) {
        current.state = 'failed';
        current.message =
          error instanceof Error ? error.message : '无法读取笔记。';
        current.snapshot = null;
        notify();
      }
    });
    const remember = () => {
      const selection = window.getSelection();
      if (
        selection?.rangeCount &&
        editor.current?.contains(selection.anchorNode) &&
        editor.current.contains(selection.focusNode)
      ) {
        caret.current = selection.getRangeAt(0).cloneRange();
        notify();
      }
    };
    let closingAfterSave = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (closingAfterSave || !current.snapshot) return;
      if (editor.current)
        current.update(
          serializeNoteDocument({
            ...model.current,
            html: editor.current.innerHTML,
          }),
        );
      if (current.state === 'saved') return;
      event.preventDefault();
      event.returnValue = '';
      void current.flush().then((saved) => {
        if (!saved || !active) return;
        closingAfterSave = true;
        window.close();
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('selectionchange', remember);
    return () => {
      active = false;
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('selectionchange', remember);
      current.dispose();
    };
  }, [bookId]);

  const editable = () =>
    Boolean(session.current?.snapshot) && session.current?.bookId === bookId;
  const commit = () => {
    if (!editor.current || !editable() || composing.current) return;
    model.current = { ...model.current, html: editor.current.innerHTML };
    const entry = {
      document: structuredClone(model.current),
      html: editor.current.innerHTML,
    };
    const previous = history.current[historyIndex.current];
    if (JSON.stringify(previous) !== JSON.stringify(entry)) {
      history.current = history.current.slice(0, historyIndex.current + 1);
      history.current.push(entry);
      if (history.current.length > 200) history.current.shift();
      historyIndex.current = history.current.length - 1;
    }
    session.current!.update(serializeNoteDocument(model.current));
  };
  const restoreCaret = (atEnd = false) => {
    const element = editor.current;
    if (!element) return null;
    element.focus({ preventScroll: true });
    let range = caret.current;
    if (atEnd || !range || !element.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  };
  const insertHtml = (html: string, atEnd = false) => {
    const range = restoreCaret(atEnd);
    if (!range) return;
    const fragment = range.createContextualFragment(html);
    const last = fragment.lastChild;
    range.deleteContents();
    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
    }
    caret.current = range.cloneRange();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    commit();
  };
  const insertSources = (items: NoteInsertion[], atEnd = false) => {
    if (!editable()) throw new Error('笔记尚未读取完成，请稍后重试。');
    const seen = new Set(model.current.importedAnnotationIds);
    const incoming = items.filter(({ anchor, annotationId }) => {
      if (anchor.bookId !== bookId || (annotationId && seen.has(annotationId)))
        return false;
      if (annotationId) seen.add(annotationId);
      return true;
    });
    if (!incoming.length) {
      setNotice('没有新的批注可汇入，已跳过重复项。');
      return;
    }
    const sources = new Map(
      model.current.sources.map((anchor) => [anchor.anchorId, anchor]),
    );
    for (const { anchor } of incoming)
      if (!sources.has(anchor.anchorId)) sources.set(anchor.anchorId, anchor);
    model.current = {
      ...model.current,
      sources: [...sources.values()],
      importedAnnotationIds: [...seen],
    };
    const html =
      incoming
        .map(
          ({ anchor, text }) =>
            `<p>${sourceMarkup(sources.get(anchor.anchorId)!)}</p>${text ? `<p>${escapeNoteText(text).replace(/\n/g, '<br>')}</p>` : ''}`,
        )
        .join('') + '<p><br></p>';
    // A source insertion adds material; an old formatting selection must not erase prose.
    if (caret.current && !caret.current.collapsed)
      caret.current.collapse(false);
    insertHtml(html, atEnd);
    setResolutions((previous) => ({
      ...previous,
      ...Object.fromEntries(
        incoming.map(({ anchor }) => [
          anchor.anchorId,
          { status: 'exact', range: anchor.range },
        ]),
      ),
    }));
    setNotice(`已插入 ${incoming.length} 条引用；可一次撤销。`);
  };
  const insertAction = useRef(insertSources);
  insertAction.current = insertSources;
  useImperativeHandle(
    ref,
    () => ({
      insertSources: (items, atEnd) => insertAction.current(items, atEnd),
      flush: () => session.current?.flush() ?? Promise.resolve(false),
    }),
    [],
  );

  const undo = (redo = false) => {
    const index = historyIndex.current + (redo ? 1 : -1);
    const entry = history.current[index];
    if (!entry || !editor.current || !editable()) return;
    historyIndex.current = index;
    model.current = structuredClone(entry.document);
    // Only undo/redo and initial loading replace the editor DOM, never an autosave.
    editor.current.innerHTML = entry.html;
    caret.current = null;
    restoreCaret(true);
    session.current!.update(serializeNoteDocument(model.current));
    notify();
  };
  const command = (name: string, value?: string) => {
    if (!editable()) return;
    restoreCaret();
    const block = document
      .queryCommandValue('formatBlock')
      .toLowerCase()
      .replace(/[<>]/g, '');
    // Block styles are toggles, just like bold and list commands. Returning to
    // a paragraph must also leave an enclosing list rather than styling its item.
    if (name === 'formatBlock' && (value === 'p' || block === value)) {
      if (document.queryCommandState('insertUnorderedList'))
        document.execCommand('insertUnorderedList', false);
      if (document.queryCommandState('insertOrderedList'))
        document.execCommand('insertOrderedList', false);
      document.execCommand('formatBlock', false, 'p');
    } else document.execCommand(name, false, value);
    const selection = window.getSelection();
    if (selection?.rangeCount)
      caret.current = selection.getRangeAt(0).cloneRange();
    commit();
    notify();
  };
  const clearFormatting = () => {
    if (!editable()) return;
    restoreCaret();
    document.execCommand('removeFormat', false);
    document.execCommand('formatBlock', false, 'p');
    if (document.queryCommandState('insertUnorderedList'))
      document.execCommand('insertUnorderedList', false);
    if (document.queryCommandState('insertOrderedList'))
      document.execCommand('insertOrderedList', false);
    commit();
  };
  const jump = async (anchorId: string) => {
    const current = session.current;
    if (!current || !(await current.flush())) return;
    try {
      const latest = await window.reader.loadNote({ bookId });
      if (session.current !== current) return;
      setResolutions(latest.resolutions);
      const resolution = latest.resolutions[anchorId];
      if (!resolution || resolution.status === 'lost') {
        setNotice(
          '位置丢失：原书不可用、原文已变化或存在歧义。快照与笔记仍然保留。',
        );
        return;
      }
      onJump?.(resolution.range);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '暂时无法定位原文。');
    }
  };
  const state = session.current?.state ?? 'loading';
  const ready = editable();
  return (
    <aside className={styles.panel} aria-label="笔记" hidden={hidden}>
      <header>
        <strong>笔记</strong>
        <span role="status">
          {
            {
              loading: '读取中…',
              pending: '待保存',
              saving: '保存中…',
              saved: '已保存',
              failed: '保存失败',
            }[state]
          }
        </span>
      </header>
      <div className={styles.toolbar} aria-label="笔记格式">
        {[
          { label: '加粗', icon: 'B', action: 'bold' },
          { label: '段落', icon: '¶', action: 'formatBlock', value: 'p' },
          { label: '标题', icon: 'H₂', action: 'formatBlock', value: 'h2' },
          { label: '项目列表', icon: '•≡', action: 'insertUnorderedList' },
          { label: '有序列表', icon: '1≡', action: 'insertOrderedList' },
          {
            label: '引用',
            icon: '❞',
            action: 'formatBlock',
            value: 'blockquote',
          },
        ].map(({ label, icon, action, value }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={
              action === 'bold'
                ? Boolean(document.queryCommandState('bold'))
                : action === 'formatBlock'
                  ? document
                      .queryCommandValue('formatBlock')
                      .toLowerCase()
                      .replace(/[<>]/g, '') === value
                  : action === 'insertUnorderedList'
                    ? Boolean(document.queryCommandState('insertUnorderedList'))
                    : action === 'insertOrderedList'
                      ? Boolean(document.queryCommandState('insertOrderedList'))
                      : undefined
            }
            disabled={!ready}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(action, value)}
          >
            {icon}
          </button>
        ))}
        <button
          type="button"
          title="清除格式"
          aria-label="清除格式"
          disabled={!ready}
          onMouseDown={(event) => event.preventDefault()}
          onClick={clearFormatting}
        >
          Tx
        </button>
        <button
          type="button"
          title="撤销"
          aria-label="撤销"
          disabled={!ready || historyIndex.current === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => undo()}
        >
          ↶
        </button>
        <button
          type="button"
          title="重做"
          aria-label="重做"
          disabled={
            !ready || historyIndex.current >= history.current.length - 1
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => undo(true)}
        >
          ↷
        </button>
        <button
          type="button"
          title="立即保存"
          aria-label="立即保存"
          disabled={!ready || state === 'saving'}
          onClick={() => void session.current?.flush()}
        >
          ⇧
        </button>
        <button
          type="button"
          title="导出恢复副本"
          aria-label="导出恢复副本"
          disabled={!ready}
          onClick={() => {
            void window.reader
              .exportNote({
                document: serializeNoteDocument({
                  ...model.current,
                  html: editor.current?.innerHTML || '',
                }),
              })
              .then((saved) => {
                if (saved) setNotice('已导出包含当前输入的 JSON 恢复副本。');
              })
              .catch((error: unknown) =>
                setNotice(
                  error instanceof Error ? error.message : '导出失败。',
                ),
              );
          }}
        >
          ⤓
        </button>
      </div>
      <div
        ref={editor}
        className={styles.editor}
        contentEditable={ready}
        suppressContentEditableWarning
        onInput={commit}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          commit();
        }}
        onBeforeInput={(event) => {
          const type = (event.nativeEvent as InputEvent).inputType;
          if (type === 'historyUndo' || type === 'historyRedo') {
            event.preventDefault();
            undo(type === 'historyRedo');
          }
        }}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            ['z', 'y'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            event.stopPropagation();
            undo(event.shiftKey || event.key.toLowerCase() === 'y');
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          if (ready)
            insertHtml(
              escapeNoteText(event.clipboardData.getData('text/plain')).replace(
                /\n/g,
                '<br>',
              ),
            );
        }}
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes('application/x-reader-selection')
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (
            !ready ||
            !event.dataTransfer.types.includes(
              'application/x-reader-selection',
            ) ||
            !onDropSource
          )
            return;
          const atPoint = (
            document as Document & {
              caretRangeFromPoint?: (x: number, y: number) => Range | null;
            }
          ).caretRangeFromPoint?.(event.clientX, event.clientY);
          if (
            atPoint &&
            editor.current?.contains(atPoint.commonAncestorContainer)
          )
            caret.current = atPoint;
          void onDropSource(
            event.dataTransfer.getData('application/x-reader-selection'),
          ).catch((error: unknown) =>
            setNotice(
              error instanceof Error ? error.message : '无法插入引用。',
            ),
          );
        }}
        onClick={(event) => {
          const target = (event.target as HTMLElement).closest(
            '[data-note-jump]',
          );
          if (target) {
            event.preventDefault();
            void jump(target.getAttribute('data-note-jump')!);
          }
        }}
        role="textbox"
        aria-label="笔记正文"
        aria-multiline="true"
        aria-busy={state === 'loading'}
        data-placeholder="在这里写下你的想法…"
      />
      {Object.entries(resolutions)
        .filter(
          ([id, resolution]) =>
            resolution.status === 'lost' && model.current.html.includes(id),
        )
        .map(([id]) => (
          <p key={id} className={styles.sourceStatus}>
            位置丢失 · 原文快照与出处仍保留
          </p>
        ))}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {state === 'failed' && (
        <p className={styles.error} role="alert">
          {session.current?.message ||
            '无法读取或保存笔记。当前输入不会被覆盖。'}{' '}
          <button
            onClick={() => {
              if (ready) void session.current?.flush();
              else
                void session.current?.load().then((loaded) => {
                  if (!loaded || !editor.current) return;
                  model.current = parseNoteDocument(session.current!.document);
                  editor.current.innerHTML = model.current.html;
                  history.current = [
                    {
                      document: structuredClone(model.current),
                      html: editor.current.innerHTML,
                    },
                  ];
                  historyIndex.current = 0;
                  setResolutions(session.current!.snapshot!.resolutions);
                });
            }}
          >
            重试
          </button>
        </p>
      )}
    </aside>
  );
});
