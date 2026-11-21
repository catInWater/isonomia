import type { RefObject } from 'react';
import type { ReadingPreferences } from '@reader/storage-bridge';
import styles from './app.module.css';

export function ReaderToolbar({
  preferences,
  update,
  notesVisible,
  toggleNotes,
  notesToggle,
  toggleFocus,
  showLicense,
}: {
  preferences: ReadingPreferences;
  update: (patch: Partial<ReadingPreferences>) => void;
  notesVisible: boolean;
  toggleNotes: () => void;
  notesToggle: RefObject<HTMLButtonElement | null>;
  toggleFocus: () => void;
  showLicense: () => void;
}) {
  return (
    <div
      className={styles.readerToolbar}
      role="toolbar"
      aria-label="阅读控制台"
    >
      <button
        aria-label="滚动阅读"
        title="滚动阅读"
        aria-pressed={preferences.mode === 'scroll'}
        onClick={() => update({ mode: 'scroll' })}
      >
        ↕
      </button>
      <button
        aria-label="分页阅读"
        title="分页阅读"
        aria-pressed={preferences.mode === 'paginated'}
        onClick={() => update({ mode: 'paginated' })}
      >
        ▤
      </button>
      <button
        aria-label="缩小字号"
        title="缩小字号"
        onClick={() =>
          update({ fontSize: Math.max(12, preferences.fontSize - 1) })
        }
      >
        A−
      </button>
      <button
        aria-label="增大字号"
        title="增大字号"
        onClick={() =>
          update({ fontSize: Math.min(36, preferences.fontSize + 1) })
        }
      >
        A+
      </button>
      <label title="行距">
        <span aria-hidden="true">↕</span>
        <select
          aria-label="行距"
          value={preferences.lineHeight}
          onChange={(event) =>
            update({ lineHeight: Number(event.target.value) })
          }
        >
          {[1.2, 1.5, 1.6, 2, 2.4].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label title="页边距">
        <span aria-hidden="true">↔</span>
        <select
          aria-label="页边距"
          value={preferences.pageMargin}
          onChange={(event) =>
            update({ pageMargin: Number(event.target.value) })
          }
        >
          {[12, 24, 40, 64].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button
        title="浅色主题"
        aria-label="浅色主题"
        aria-pressed={preferences.theme === 'light'}
        onClick={() => update({ theme: 'light' })}
      >
        ☼
      </button>
      <button
        title="护眼主题"
        aria-label="护眼主题"
        aria-pressed={preferences.theme === 'sepia'}
        onClick={() => update({ theme: 'sepia' })}
      >
        ◐
      </button>
      <button
        title="深色主题"
        aria-label="深色主题"
        aria-pressed={preferences.theme === 'dark'}
        onClick={() => update({ theme: 'dark' })}
      >
        ☾
      </button>
      <button title="专注模式 (F)" aria-label="专注模式" onClick={toggleFocus}>
        ⛶
      </button>
      <button
        id="reader-notes-toggle"
        ref={notesToggle}
        aria-label={notesVisible ? '收起笔记' : '打开笔记'}
        aria-expanded={notesVisible}
        aria-controls="reader-notes"
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleNotes}
      >
        note
      </button>
      <button aria-label="关于与许可" title="关于与许可" onClick={showLicense}>
        ⓘ
      </button>
    </div>
  );
}
