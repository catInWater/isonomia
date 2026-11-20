import type { NoteSnapshot, SaveNoteRequest } from '@reader/storage-bridge';

export type NoteSaveState =
  'loading' | 'saved' | 'pending' | 'saving' | 'failed';
type Bridge = {
  loadNote(request: { bookId: string }): Promise<NoteSnapshot>;
  saveNote(request: SaveNoteRequest): Promise<NoteSnapshot>;
};

/** One session per book. Serializes writes and reconciles ambiguous acknowledgements. */
export class NoteSaveSession {
  state: NoteSaveState = 'loading';
  message = '';
  document = '';
  snapshot: NoteSnapshot | null = null;
  private acknowledged = '';
  private attempted: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<boolean> | null = null;
  private uncertain = false;
  private disposed = false;

  readonly bookId: string;
  private bridge: Bridge;
  private notify: () => void;
  private delay: number;

  constructor(
    bookId: string,
    bridge: Bridge,
    notify: () => void,
    delay = 1500,
  ) {
    this.bookId = bookId;
    this.bridge = bridge;
    this.notify = notify;
    this.delay = delay;
  }

  async load(): Promise<boolean> {
    if (this.snapshot) return true;
    this.state = 'loading';
    this.notify();
    try {
      const note = await this.bridge.loadNote({ bookId: this.bookId });
      if (this.disposed) return false;
      this.snapshot = note;
      this.document = this.acknowledged = note.document;
      this.state = 'saved';
      this.message = '';
      this.notify();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  update(document: string): void {
    if (!this.snapshot || this.disposed || this.document === document) return;
    this.document = document;
    this.state = this.uncertain ? 'failed' : 'pending';
    clearTimeout(this.timer);
    if (!this.uncertain)
      this.timer = setTimeout(() => void this.flush(), this.delay);
    this.notify();
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.disposed || !this.snapshot) return Promise.resolve(false);
    if (this.flight) return this.flight;
    this.flight = this.persist().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async persist(): Promise<boolean> {
    try {
      if (this.uncertain) {
        // A publish can succeed while its acknowledgement fails. Never blindly retry.
        const latest = await this.bridge.loadNote({ bookId: this.bookId });
        if (latest.document === this.attempted) {
          this.snapshot = latest;
          this.acknowledged = latest.document;
        } else if (latest.revision !== this.snapshot!.revision) {
          throw new Error(
            '笔记已在其他位置变化。当前输入仍保留，请先导出副本，再重新打开核对；不会覆盖其他修订。',
          );
        }
        this.uncertain = false;
      }
      while (this.document !== this.acknowledged) {
        const document = this.document;
        this.attempted = document;
        this.state = 'saving';
        this.notify();
        const saved = await this.bridge.saveNote({
          bookId: this.bookId,
          expectedRevision: this.snapshot!.revision,
          document,
        });
        this.snapshot = saved;
        this.acknowledged = document;
      }
      this.state = 'saved';
      this.message = '';
      this.attempted = null;
      this.notify();
      return true;
    } catch (error) {
      this.uncertain = true;
      this.fail(error);
      return false;
    }
  }

  private fail(error: unknown): void {
    this.state = 'failed';
    this.message =
      error instanceof Error
        ? error.message
        : '无法确认保存，请检查磁盘空间与权限。';
    if (!this.disposed) this.notify();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposed = true;
  }
}
