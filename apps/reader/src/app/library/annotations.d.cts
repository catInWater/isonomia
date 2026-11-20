import type {
  AnnotationRequest,
  AnnotationSnapshot,
} from '@reader/storage-bridge';
import type { DurableStore } from '../storage/index.cjs';
import type { LibraryManager } from './index.cjs';
import type { ReadingManager } from './reading.cjs';

export function validAnnotationRequest(
  method: string,
  request: unknown,
): boolean;
export class AnnotationsManager {
  constructor(options: {
    store: DurableStore;
    library: LibraryManager;
    reading: ReadingManager;
  });
  list(request: { bookId: string }): Promise<AnnotationSnapshot>;
  change(request: AnnotationRequest): Promise<AnnotationSnapshot>;
  copyText(request: { bookId: string; highlightId: string }): Promise<string>;
}
