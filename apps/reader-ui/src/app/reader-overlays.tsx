import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './app.module.css';

export interface OverlayAnchor {
  left: number;
  top: number;
  bottom: number;
}

export function ReaderPopover({
  anchor,
  label,
  children,
  close,
  dismissOutside,
}: {
  anchor: OverlayAnchor;
  label: string;
  children: ReactNode;
  close: () => void;
  dismissOutside?: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ left: 16, top: 16 });
  useLayoutEffect(() => {
    const update = () => {
      const rect = element.current?.getBoundingClientRect();
      if (!rect) return;
      const preferredTop =
        anchor.top >= rect.height + 24
          ? anchor.top - rect.height - 8
          : anchor.bottom + 8;
      setPoint({
        left: Math.max(
          16,
          Math.min(
            anchor.left - rect.width,
            window.innerWidth - rect.width - 16,
          ),
        ),
        top: Math.max(
          16,
          Math.min(preferredTop, window.innerHeight - rect.height - 16),
        ),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (element.current) observer.observe(element.current);
    window.addEventListener('resize', update);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', escape, true);
    const outside = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node))
        (dismissOutside ?? close)();
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [anchor, close, dismissOutside]);
  return (
    <div
      ref={element}
      className={styles.readerPopover}
      role="dialog"
      aria-label={label}
      style={point}
    >
      <button
        className={styles.popoverClose}
        aria-label={`关闭${label}`}
        title="关闭"
        onClick={close}
      >
        ×
      </button>
      {children}
    </div>
  );
}
