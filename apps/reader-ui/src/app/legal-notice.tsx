import { useEffect, useRef } from 'react';
import licenseText from '../assets/AGPL-3.0-or-later.txt';
import styles from './app.module.css';

export function LegalNotice({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  return (
    <div
      className={styles.legalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={styles.legalPanel}
        role="dialog"
        aria-modal="true"
        aria-label="许可证信息"
        aria-labelledby="legal-notice-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className={styles.legalHeader}>
          <h2 id="legal-notice-title">关于与许可</h2>
          <button
            className={styles.licenseButton}
            aria-label="关闭关于与许可"
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        <div className={styles.legalBody}>
          <p>
            Reader 按 GNU Affero General Public License v3.0 或之后版本
            （AGPL-3.0-or-later）发布。你可以依照该许可证复制、分发和修改本程序。
          </p>
          <p>本程序按“现状”提供，不提供任何明示或默示担保。</p>
          <details>
            <summary>查看完整许可证副本</summary>
            <pre>{licenseText}</pre>
          </details>
        </div>
      </section>
    </div>
  );
}
