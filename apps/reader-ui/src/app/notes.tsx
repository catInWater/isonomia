import { useEffect, useRef, useState } from 'react';
import type { NoteSnapshot } from '@reader/storage-bridge';
import styles from './notes.module.css';
import { sanitizeNoteDocument } from './note-document';

export function NotePanel({ bookId }: { bookId: string }) {
  const editor = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'loading' | 'saved' | 'saving' | 'failed'>(
    'loading',
  );
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    revision.current = 0;
    setState('loading');
    void window.reader
      .loadNote({ bookId })
      .then((note: NoteSnapshot) => {
        if (!active || !editor.current) return;
        editor.current.innerHTML = sanitizeNoteDocument(note.document);
        revision.current = note.revision;
        setState('saved');
      })
      .catch(() => active && setState('failed'));
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bookId]);

  const save = () => {
    if (!editor.current) return;
    setState('saving');
    void window.reader
      .saveNote({
        bookId,
        expectedRevision: revision.current,
        document: sanitizeNoteDocument(editor.current.innerHTML),
      })
      .then((note) => {
        revision.current = note.revision;
        setState('saved');
        setMessage('');
      })
      .catch((error: unknown) => {
        setState('failed');
        setMessage(
          error instanceof Error ? error.message : '保存失败，请重试。',
        );
      });
  };
  const changed = () => {
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, 2000);
  };
  const command = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
    changed();
  };
  return (
    <aside className={styles.panel} aria-label="笔记">
      <header>
        <strong>笔记</strong>
        <span role="status">
          {state === 'loading'
            ? '读取中…'
            : state === 'saving'
              ? '保存中…'
              : state === 'saved'
                ? '已保存'
                : '保存失败'}
        </span>
      </header>
      <div className={styles.toolbar} aria-label="笔记格式">
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('bold')}
          aria-label="加粗"
        >
          B
        </button>
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('formatBlock', 'h2')}
        >
          标题
        </button>
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('insertUnorderedList')}
        >
          列表
        </button>
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('formatBlock', 'blockquote')}
        >
          引用
        </button>
        <button onClick={save} disabled={state === 'saving'}>
          立即保存
        </button>
      </div>
      <div
        ref={editor}
        className={styles.editor}
        contentEditable
        suppressContentEditableWarning
        onInput={changed}
        role="textbox"
        aria-multiline="true"
        data-placeholder="在这里写下你的想法…"
      />
      {state === 'failed' && (
        <p className={styles.error} role="alert">
          {message || '保存失败，内容仍保留在编辑器中。'}{' '}
          <button onClick={save}>重试</button>
        </p>
      )}
    </aside>
  );
}
