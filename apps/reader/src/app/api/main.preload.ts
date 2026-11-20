import { contextBridge, ipcRenderer } from 'electron';
import type {
  RecoveryCandidate,
  RecoverySelection,
  Json,
  RecordValue,
} from '../storage/index.cjs';
import type {
  RecoveryStatus,
  StorageBridge,
  SaveReadingRequest,
  AnnotationRequest,
} from '@reader/storage-bridge';

contextBridge.exposeInMainWorld(
  'reader',
  Object.freeze({
    getAppVersion: (): Promise<string> => ipcRenderer.invoke('reader:version'),
    getStorageStatus: (): Promise<RecoveryStatus> =>
      ipcRenderer.invoke('reader:storageStatus'),
    load: (id: string): Promise<RecordValue | null> =>
      ipcRenderer.invoke('reader:load', id),
    save: (
      id: string,
      data: Json,
      expectedRevision: number,
    ): Promise<RecordValue> =>
      ipcRenderer.invoke('reader:save', id, data, expectedRevision),
    listRecovery: (id: string): Promise<RecoveryCandidate[]> =>
      ipcRenderer.invoke('reader:listRecovery', id),
    recover: (id: string, selection: RecoverySelection): Promise<RecordValue> =>
      ipcRenderer.invoke('reader:recover', id, selection),
    libraryList: () => ipcRenderer.invoke('reader:libraryList'),
    libraryCover: (bookId: string): Promise<string | null> =>
      ipcRenderer.invoke('reader:libraryCover', bookId),
    libraryImport: () => ipcRenderer.invoke('reader:libraryImport'),
    libraryRemove: (bookId: string, keepNotes: boolean) =>
      ipcRenderer.invoke('reader:libraryRemove', bookId, keepNotes),
    libraryOpen: (bookId: string) =>
      ipcRenderer.invoke('reader:libraryOpen', bookId),
    openBook: (request: { bookId: string }) =>
      ipcRenderer.invoke('reader:openBook', request),
    readChapter: (request: { bookId: string; chapterId: string }) =>
      ipcRenderer.invoke('reader:readChapter', request),
    saveReading: (request: SaveReadingRequest) =>
      ipcRenderer.invoke('reader:saveReading', request),
    libraryReplace: (bookId: string) =>
      ipcRenderer.invoke('reader:libraryReplace', bookId),
    listAnnotations: (request: { bookId: string }) =>
      ipcRenderer.invoke('reader:listAnnotations', request),
    changeAnnotation: (request: AnnotationRequest) =>
      ipcRenderer.invoke('reader:changeAnnotation', request),
    copyAnnotation: (request: { bookId: string; highlightId: string }) =>
      ipcRenderer.invoke('reader:copyAnnotation', request),
  } satisfies StorageBridge),
);
